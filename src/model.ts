/**
 * Pure data model for Neovim marks. No `vscode` import here so it can be
 * unit-tested with plain Node.
 */

export type MarkKind = "local" | "global";

/** One mark as sent by the Neovim side (1-based line/UTF-8 byte column). */
export interface WireMark {
  name: string;
  line: number;
  col: number;
}

export interface WireLocalEntry {
  file: string;
  marks: WireMark[];
}

export interface WireGlobalMark extends WireMark {
  file: string;
}

/** Payload pushed by lua/nvim-marks/init.lua via `vscode.action("nvimMarks.update", { args = { payload } })`. */
export interface WirePayload {
  /** Wire protocol version, see `PROTOCOL_VERSION`. */
  version: number;
  /** Release of the Neovim plugin; absent before 0.1.3. */
  plugin_version?: string;
  locals: WireLocalEntry[];
  globals: WireGlobalMark[];
}

/** Normalized mark stored on the VS Code side (0-based line/col). */
export interface Mark {
  name: string;
  kind: MarkKind;
  /** Normalized file key, see `normalizePath`. */
  file: string;
  /** 0-based line. */
  line: number;
  /** 0-based UTF-8 byte column, as reported by Neovim. */
  col: number;
}

export interface MarkStore {
  /** Marks grouped by normalized file key. */
  byFile: Map<string, Mark[]>;
}

const LOCAL_RE = /^[a-z]$/;
const GLOBAL_RE = /^[A-Z]$/;

export interface PathNormalizer {
  (p: string): string;
}

/** Default normalizer: forward slashes, strip trailing slash, case-fold on Windows. */
export function makeNormalizer(platform: string): PathNormalizer {
  const win = platform === "win32";
  return (p: string) => {
    let s = p.replace(/\\/g, "/");
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    if (win) s = s.toLowerCase();
    return s;
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/** Wire protocol version this extension understands (`version` in the payload). */
export const PROTOCOL_VERSION = 1;

/**
 * Oldest Neovim plugin release that needs no update. 0.1.4 introduced the
 * backtick picker mapping; earlier releases cannot provide that shortcut.
 */
export const MIN_PLUGIN_VERSION = "0.1.4";

/** What a payload says about the Neovim half. */
export interface PayloadInfo {
  protocol?: number;
  pluginVersion?: string;
}

export interface CompatIssue {
  /** Which half has to be updated. */
  outdated: "extension" | "plugin";
  message: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Compare the numeric major.minor.patch of two versions; a suffix such as
 * "-alpha.1" is ignored. Undefined if either one does not parse.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) return undefined;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Version fields of a wire payload, or undefined if it is not a payload at all. */
export function payloadInfo(raw: unknown): PayloadInfo | undefined {
  if (!isObject(raw)) return undefined;
  const info: PayloadInfo = {};
  const protocol = num(raw.version);
  if (protocol !== undefined) info.protocol = protocol;
  if (typeof raw.plugin_version === "string" && raw.plugin_version !== "") info.pluginVersion = raw.plugin_version;
  return info;
}

/** Decide whether the two halves fit together; undefined means they do. */
export function checkCompat(info: PayloadInfo): CompatIssue | undefined {
  const { protocol, pluginVersion } = info;
  const updatePlugin = "Update the Neovim plugin (e.g. `:Lazy update vscode-nvim-marks`) and reload the VS Code window.";
  if (protocol !== undefined && protocol > PROTOCOL_VERSION) {
    return {
      outdated: "extension",
      message: `the Neovim plugin sends protocol ${protocol}, this extension understands ${PROTOCOL_VERSION}. Update the Neovim Marks extension in VS Code.`,
    };
  }
  if (protocol !== undefined && protocol < PROTOCOL_VERSION) {
    return {
      outdated: "plugin",
      message: `the Neovim plugin sends protocol ${protocol}, this extension needs ${PROTOCOL_VERSION}. ${updatePlugin}`,
    };
  }
  const cmp = pluginVersion === undefined ? undefined : compareVersions(pluginVersion, MIN_PLUGIN_VERSION);
  if (cmp === undefined || cmp < 0) {
    return {
      outdated: "plugin",
      message: `the nvim-marks Neovim plugin is ${pluginVersion ?? `older than ${MIN_PLUGIN_VERSION}`}, ${MIN_PLUGIN_VERSION} or newer is recommended. ${updatePlugin}`,
    };
  }
  return undefined;
}

/**
 * Validate and normalize a wire payload into a MarkStore. Unknown or malformed
 * entries are dropped silently rather than throwing: the Lua side is trusted
 * but the message crosses an RPC boundary.
 */
export function buildStore(raw: unknown, normalize: PathNormalizer): MarkStore {
  const byFile = new Map<string, Mark[]>();
  if (!isObject(raw)) return { byFile };

  const push = (m: Mark) => {
    const list = byFile.get(m.file);
    if (list) list.push(m);
    else byFile.set(m.file, [m]);
  };

  const locals = Array.isArray(raw.locals) ? raw.locals : [];
  for (const entry of locals) {
    if (!isObject(entry) || typeof entry.file !== "string" || entry.file === "") continue;
    const file = normalize(entry.file);
    const marks = Array.isArray(entry.marks) ? entry.marks : [];
    for (const wm of marks) {
      if (!isObject(wm) || typeof wm.name !== "string" || !LOCAL_RE.test(wm.name)) continue;
      const line = num(wm.line);
      if (line === undefined || line < 1) continue;
      const col = num(wm.col) ?? 1;
      push({ name: wm.name, kind: "local", file, line: line - 1, col: Math.max(0, col - 1) });
    }
  }

  const globals = Array.isArray(raw.globals) ? raw.globals : [];
  for (const wm of globals) {
    if (!isObject(wm) || typeof wm.name !== "string" || !GLOBAL_RE.test(wm.name)) continue;
    if (typeof wm.file !== "string" || wm.file === "") continue;
    const line = num(wm.line);
    if (line === undefined || line < 1) continue;
    const col = num(wm.col) ?? 1;
    push({ name: wm.name, kind: "global", file: normalize(wm.file), line: line - 1, col: Math.max(0, col - 1) });
  }

  for (const list of byFile.values()) list.sort(compareMarks);
  return { byFile };
}

export function compareMarks(a: Mark, b: Mark): number {
  if (a.line !== b.line) return a.line - b.line;
  if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** A line that carries one or more marks, with the label to draw for it. */
export interface LineLabel {
  line: number;
  /** Text drawn in the gutter: "a", "aB", "ab+" ... */
  label: string;
  /** "global" if any mark on this line is global, else "local". */
  kind: MarkKind;
  marks: Mark[];
}

export interface LabelOptions {
  showLocal: boolean;
  showGlobal: boolean;
  /** Max letters to draw before collapsing into "+" (default 2). */
  maxLetters?: number;
}

/**
 * Group marks of one file by line and compute the gutter label. VS Code draws
 * at most one gutter icon per decoration type per line, and CSS classes from
 * several types collide, so one combined icon per line is the only reliable
 * approach.
 */
export function groupByLine(marks: Mark[], opts: LabelOptions): LineLabel[] {
  const maxLetters = opts.maxLetters ?? 2;
  const lines = new Map<number, Mark[]>();
  for (const m of marks) {
    if (m.kind === "local" && !opts.showLocal) continue;
    if (m.kind === "global" && !opts.showGlobal) continue;
    const list = lines.get(m.line);
    if (list) list.push(m);
    else lines.set(m.line, [m]);
  }
  const out: LineLabel[] = [];
  for (const [line, list] of lines) {
    list.sort(compareMarks);
    const names = list.map((m) => m.name);
    const label = names.length > maxLetters ? names.slice(0, maxLetters - 1).join("") + "+" : names.join("");
    const kind: MarkKind = list.some((m) => m.kind === "global") ? "global" : "local";
    out.push({ line, label, kind, marks: list });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/** Stable key for a decoration type: style + kind + label. */
export function decorationKey(kind: MarkKind, label: string): string {
  return `${kind}:${label}`;
}
