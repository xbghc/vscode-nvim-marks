import * as vscode from "vscode";
import * as path from "node:path";
import {
  buildStore,
  checkCompat,
  decorationKey,
  groupByLine,
  makeNormalizer,
  payloadInfo,
  PROTOCOL_VERSION,
  type CompatIssue,
  type Mark,
  type MarkKind,
  type MarkStore,
  type PathNormalizer,
  type PayloadInfo,
} from "./model";
import { markIconUri, type IconColors } from "./icons";
import { NeovimBridge } from "./neovim";

type Style = "gutter" | "eol" | "both";

interface Settings {
  enabled: boolean;
  style: Style;
  overviewRuler: boolean;
  showLocal: boolean;
  showGlobal: boolean;
  localColor: IconColors;
  globalColor: IconColors;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("nvimMarks");
  const color = (key: string, fallback: IconColors): IconColors => {
    const v = c.get<Partial<IconColors>>(key);
    return { light: v?.light ?? fallback.light, dark: v?.dark ?? fallback.dark };
  };
  return {
    enabled: c.get<boolean>("enabled", true),
    style: c.get<Style>("style", "gutter"),
    overviewRuler: c.get<boolean>("overviewRuler", true),
    showLocal: c.get<boolean>("showLocalMarks", true),
    showGlobal: c.get<boolean>("showGlobalMarks", true),
    localColor: color("localColor", { light: "#4d4d4d", dark: "#bdbdbd" }),
    globalColor: color("globalColor", { light: "#1a1a1a", dark: "#f2f2f2" }),
  };
}

class MarkRenderer implements vscode.Disposable {
  private store: MarkStore = { byFile: new Map() };
  private settings = readSettings();
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private applied = new Map<string, Map<string, vscode.Range[]>>();
  private readonly normalize: PathNormalizer;
  private runtimeEnabled = true;

  constructor(private readonly output: vscode.OutputChannel) {
    this.normalize = makeNormalizer(process.platform);
  }

  /** Called by the `nvimMarks.update` command with the payload from Lua. */
  update(payload: unknown): void {
    this.store = buildStore(payload, this.normalize);
    let total = 0;
    for (const l of this.store.byFile.values()) total += l.length;
    this.output.appendLine(`update: ${total} mark(s) in ${this.store.byFile.size} file(s)`);
    this.applyAll();
  }

  reloadSettings(): void {
    this.settings = readSettings();
    this.disposeTypes();
    this.applyAll();
  }

  toggle(): boolean {
    this.runtimeEnabled = !this.runtimeEnabled;
    this.applyAll();
    return this.runtimeEnabled;
  }

  /** One line for the status report: the settings that decide what is drawn. */
  get settingsSummary(): string {
    const s = this.settings;
    const shown = s.enabled && this.runtimeEnabled ? "shown" : s.enabled ? "hidden by toggle" : "disabled";
    return `${shown}, style=${s.style}, showLocalMarks=${s.showLocal}, showGlobalMarks=${s.showGlobal}`;
  }

  get allMarks(): Mark[] {
    const out: Mark[] = [];
    for (const l of this.store.byFile.values()) out.push(...l);
    return out;
  }

  marksFor(doc: vscode.TextDocument): Mark[] {
    return this.store.byFile.get(this.fileKey(doc)) ?? [];
  }

  applyAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  apply(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return;
    const marks = this.store.byFile.get(this.fileKey(doc)) ?? [];
    const wanted = new Map<string, vscode.Range[]>();

    if (this.settings.enabled && this.runtimeEnabled) {
      const lines = groupByLine(marks, {
        showLocal: this.settings.showLocal,
        showGlobal: this.settings.showGlobal,
      });
      for (const ll of lines) {
        if (ll.line >= doc.lineCount) continue;
        const key = decorationKey(ll.kind, ll.label);
        const range = doc.lineAt(ll.line).range;
        const list = wanted.get(key);
        if (list) list.push(range);
        else wanted.set(key, [range]);
      }
    }

    // Clear types no longer used in this editor, set the ones that are.
    for (const [key, type] of this.types) {
      if (!wanted.has(key)) editor.setDecorations(type, []);
    }
    for (const [key, ranges] of wanted) {
      editor.setDecorations(this.typeFor(key), ranges);
    }
    this.applied.set(doc.uri.toString(), wanted);
  }

  /** What was last drawn for a document: decoration key -> ranges. Exposed for tests. */
  appliedFor(doc: vscode.TextDocument): Map<string, vscode.Range[]> {
    return this.applied.get(doc.uri.toString()) ?? new Map();
  }

  private fileKey(doc: vscode.TextDocument): string {
    return this.normalize(doc.uri.fsPath);
  }

  private typeFor(key: string): vscode.TextEditorDecorationType {
    const existing = this.types.get(key);
    if (existing) return existing;
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep) as MarkKind;
    const label = key.slice(sep + 1);
    const colors = kind === "global" ? this.settings.globalColor : this.settings.localColor;
    const s = this.settings;

    const perTheme = (color: string): vscode.ThemableDecorationRenderOptions => {
      const o: vscode.ThemableDecorationRenderOptions = {};
      if (s.style === "gutter" || s.style === "both") {
        o.gutterIconPath = vscode.Uri.parse(markIconUri(label, color));
        o.gutterIconSize = "contain";
      }
      if (s.style === "eol" || s.style === "both") {
        o.after = {
          contentText: ` ${kind === "global" ? "[" + label + "]" : label}`,
          color,
          fontWeight: "bold",
          margin: "0 0 0 1em",
        };
      }
      if (s.overviewRuler) o.overviewRulerColor = color;
      return o;
    };

    const type = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerLane: s.overviewRuler ? vscode.OverviewRulerLane.Left : undefined,
      isWholeLine: s.style !== "gutter",
      light: perTheme(colors.light),
      dark: perTheme(colors.dark),
    });
    this.types.set(key, type);
    return type;
  }

  private disposeTypes(): void {
    for (const t of this.types.values()) t.dispose();
    this.types.clear();
  }

  dispose(): void {
    this.disposeTypes();
  }
}

interface MarkPickItem extends vscode.QuickPickItem {
  /** Separators have no target. */
  mark?: Mark;
}

function markPickItems(renderer: MarkRenderer, preview = false): MarkPickItem[] {
  const active = vscode.window.activeTextEditor;
  const normalize = makeNormalizer(process.platform);
  const activeKey = active?.document.uri.scheme === "file" ? normalize(active.document.uri.fsPath) : undefined;
  // Local marks in other buffers cannot be reached by a native two-key jump.
  const marks = renderer.allMarks.filter((m) => !preview || m.kind === "global" || m.file === activeKey);
  const items: MarkPickItem[] = [];
  const inActive = marks.filter((m) => m.file === activeKey);
  const elsewhere = marks.filter((m) => m.file !== activeKey).sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.col - b.col || a.name.localeCompare(b.name),
  );

  const lineText = (m: Mark): string => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && normalize(d.uri.fsPath) === m.file);
    if (!doc || m.line >= doc.lineCount) return "";
    return doc.lineAt(m.line).text.trim();
  };
  const rel = (file: string): string => {
    const uri = vscode.Uri.file(file);
    return vscode.workspace.asRelativePath(uri);
  };
  const toItem = (m: Mark): MarkPickItem => ({
    label: `${m.name} ${lineText(m) || path.basename(m.file)}`.replace(/\$\(/g, "\\$("),
    description: `${rel(m.file)}:${m.line + 1}:${m.col + 1}`,
    mark: m,
  });

  if (inActive.length > 0) {
    items.push({ label: "current file", kind: vscode.QuickPickItemKind.Separator });
    items.push(...inActive.map(toItem));
  }
  if (elsewhere.length > 0) {
    items.push({ label: "other files", kind: vscode.QuickPickItemKind.Separator });
    items.push(...elsewhere.map(toItem));
  }

  return items;
}

async function listMarks(renderer: MarkRenderer): Promise<void> {
  const items = markPickItems(renderer);
  const picked = await vscode.window.showQuickPick(items, {
    title: "Neovim Marks",
    placeHolder: items.length > 0
      ? "Search marks, files or locations; Enter to jump"
      : "No marks yet. Set one with m{a-zA-Z} in Neovim.",
    matchOnDescription: true,
  });
  if (!picked?.mark) return;
  const m = picked.mark;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
    const pos = markPosition(doc, m);
    const selection = new vscode.Range(pos, pos);
    const editor = await vscode.window.showTextDocument(doc, { selection, preserveFocus: false });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Neovim Marks: could not open mark ${m.name} in ${vscode.workspace.asRelativePath(vscode.Uri.file(m.file))}. ${message}`);
  }
}

/** A mark reference that stays visible while Neovim receives the target key. */
class MarkPreview implements vscode.Disposable {
  private picker?: vscode.QuickPick<MarkPickItem>;
  private subscriptions: vscode.Disposable[] = [];

  async show(renderer: MarkRenderer): Promise<void> {
    this.dispose();
    if (!vscode.window.activeTextEditor) return;
    const picker = vscode.window.createQuickPick<MarkPickItem>();
    this.picker = picker;
    picker.items = markPickItems(renderer, true);
    picker.title = "Neovim Marks — press a mark key to jump";
    picker.placeholder = picker.items.length > 0
      ? "Press a mark key to jump; Esc to cancel"
      : "No marks yet. Esc to cancel, then set one with m{a-zA-Z}.";
    picker.ignoreFocusOut = true;
    const send = (key: string): void => {
      this.dispose();
      void vscode.commands.executeCommand("vscode-neovim.send", key === "<" ? "<LT>" : key);
    };
    this.subscriptions.push(
      // Cover input during the brief show/focus handoff, or a click in the box:
      // a target key always goes to Neovim instead of filtering the preview.
      picker.onDidChangeValue((value) => { if (value) send(Array.from(value)[0]); }),
      picker.onDidAccept(() => {
        const mark = picker.selectedItems[0]?.mark;
        if (mark) send(mark.name);
      }),
      picker.onDidHide(() => send("<Esc>")),
    );
    picker.show();
    // QuickPick opens with input focus. Keep it visible on blur, then return
    // input to the editor where the Neovim mapping is awaiting the mark key.
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.picker?.dispose();
    this.picker = undefined;
  }
}

/** Neovim reports UTF-8 byte columns; VS Code selections use UTF-16 offsets. */
function markPosition(doc: vscode.TextDocument, mark: Mark): vscode.Position {
  const line = Math.min(Math.floor(mark.line), doc.lineCount - 1);
  const text = doc.lineAt(line).text;
  let bytes = 0;
  let character = 0;
  for (const codePoint of text) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes + width > mark.col) break;
    bytes += width;
    character += codePoint.length;
  }
  return new vscode.Position(line, character);
}

/** What the extension knows about both halves; printed by `nvimMarks.status`. */
export interface NvimMarksStatus {
  extensionVersion: string;
  bridge: string;
  /** Payloads received since activation. */
  updates: number;
  /** From the last payload; undefined before the first one or when the plugin did not report it. */
  pluginVersion?: string;
  pluginProtocol?: number;
  /** Set when the two halves do not fit together. */
  issue?: CompatIssue;
  localMarks: number;
  globalMarks: number;
}

/** Public API returned from `activate`, reachable via `vscode.extensions.getExtension("xbghc.nvim-marks").exports`. */
export interface NvimMarksApi {
  /** Versions of both halves and mark counts. */
  status(): NvimMarksStatus;
  /** All marks currently known, 0-based positions, normalized file keys. */
  marks(): Mark[];
  /** Marks known for one document. */
  marksFor(doc: vscode.TextDocument): Mark[];
  /** Decoration key -> ranges last applied to a document. */
  appliedFor(doc: vscode.TextDocument): Map<string, vscode.Range[]>;
}

let bridge: NeovimBridge | undefined;

export function activate(context: vscode.ExtensionContext): NvimMarksApi {
  const output = vscode.window.createOutputChannel("Neovim Marks");
  const renderer = new MarkRenderer(output);
  const preview = new MarkPreview();
  const extensionVersion = String(context.extension.packageJSON.version);
  output.appendLine(`activated ${extensionVersion} (${process.platform}, cwd ${path.basename(process.cwd())})`);

  let updates = 0;
  let info: PayloadInfo | undefined;
  let issue: CompatIssue | undefined;
  const warned = new Set<string>();

  const status = (): NvimMarksStatus => {
    const marks = renderer.allMarks;
    const s: NvimMarksStatus = {
      extensionVersion,
      bridge: bridge?.state ?? "starting",
      updates,
      localMarks: marks.filter((m) => m.kind === "local").length,
      globalMarks: marks.filter((m) => m.kind === "global").length,
    };
    if (info?.pluginVersion !== undefined) s.pluginVersion = info.pluginVersion;
    if (info?.protocol !== undefined) s.pluginProtocol = info.protocol;
    if (issue) s.issue = issue;
    return s;
  };

  const showStatus = (): void => {
    const s = status();
    const plugin =
      s.updates === 0
        ? "nothing received yet; check the Lua bridge status below"
        : `${s.pluginVersion ?? "version not reported"} (protocol ${s.pluginProtocol ?? "?"}), ${s.updates} payload(s) received`;
    output.appendLine("status:");
    output.appendLine(`  extension      ${s.extensionVersion} (protocol ${PROTOCOL_VERSION})`);
    output.appendLine(`  neovim plugin  ${plugin}`);
    output.appendLine(`  Lua bridge     ${s.bridge}`);
    output.appendLine(`  marks          ${s.localMarks} local (a-z), ${s.globalMarks} global (A-Z)`);
    output.appendLine(`  decorations    ${renderer.settingsSummary}`);
    output.appendLine(`  compatibility  ${s.issue ? s.issue.message : "ok"}`);
    output.show(true);
  };

  /** Warn once per window about each distinct mismatch, and never again once dismissed. */
  const warn = (i: CompatIssue): void => {
    const key = `dismissed:${i.outdated}:${info?.pluginVersion ?? "?"}:${info?.protocol ?? "?"}:${extensionVersion}`;
    if (warned.has(key) || context.globalState.get<boolean>(key)) return;
    warned.add(key);
    output.appendLine(`warning: ${i.message}`);
    void vscode.window.showWarningMessage(`Neovim Marks: ${i.message}`, "Show Status", "Don't Show Again").then((choice) => {
      if (choice === "Show Status") showStatus();
      else if (choice === "Don't Show Again") void context.globalState.update(key, true);
    });
  };

  const onUpdate = (payload: unknown): void => {
    renderer.update(payload);
    updates++;
    const next = payloadInfo(payload);
    if (updates === 1 || next?.pluginVersion !== info?.pluginVersion || next?.protocol !== info?.protocol) {
      output.appendLine(`neovim plugin: ${next?.pluginVersion ?? "version not reported"} (protocol ${next?.protocol ?? "?"})`);
    }
    info = next;
    issue = next ? checkCompat(next) : undefined;
    if (issue) warn(issue);
  };

  context.subscriptions.push(
    output,
    renderer,
    preview,
    vscode.commands.registerCommand("nvimMarks.update", onUpdate),
    vscode.commands.registerCommand("nvimMarks.status", showStatus),
    vscode.commands.registerCommand("nvimMarks.list", (payload?: unknown) => {
      // The Neovim mapping sends its fresh snapshot with this command so the
      // picker cannot overtake a debounced or asynchronous update.
      if (payload !== undefined) onUpdate(payload);
      return listMarks(renderer);
    }),
    vscode.commands.registerCommand("nvimMarks.preview", (payload: unknown) => {
      onUpdate(payload);
      return preview.show(renderer);
    }),
    vscode.commands.registerCommand("nvimMarks.hidePreview", () => preview.dispose()),
    vscode.commands.registerCommand("nvimMarks.toggle", () => {
      const on = renderer.toggle();
      void vscode.window.setStatusBarMessage(`Neovim Marks: ${on ? "shown" : "hidden"}`, 2000);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => renderer.applyAll()),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) renderer.apply(e);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nvimMarks")) renderer.reloadSettings();
    }),
  );

  bridge = new NeovimBridge(context, output);
  context.subscriptions.push(bridge);
  void bridge.start();

  return {
    status,
    marks: () => renderer.allMarks,
    marksFor: (doc) => renderer.marksFor(doc),
    appliedFor: (doc) => renderer.appliedFor(doc),
  };
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
}
