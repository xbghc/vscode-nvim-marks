import * as vscode from "vscode";
import * as path from "node:path";
import {
  buildStore,
  decorationKey,
  groupByLine,
  makeNormalizer,
  type Mark,
  type MarkKind,
  type MarkStore,
  type PathNormalizer,
} from "./model";
import { markIconUri, type IconColors } from "./icons";

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
        o.gutterIconPath = vscode.Uri.parse(markIconUri(label, kind, color));
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
  mark: Mark;
}

async function listMarks(renderer: MarkRenderer): Promise<void> {
  const active = vscode.window.activeTextEditor;
  const activeKey = active ? active.document.uri.fsPath : undefined;
  const normalize = makeNormalizer(process.platform);
  const marks = renderer.allMarks;
  if (marks.length === 0) {
    void vscode.window.showInformationMessage("Neovim Marks: no marks known yet. Set one with `m{a-zA-Z}` in Neovim.");
    return;
  }

  const items: MarkPickItem[] = [];
  const inActive = marks.filter((m) => activeKey !== undefined && m.file === normalize(activeKey));
  const elsewhere = marks.filter((m) => !inActive.includes(m));

  const lineText = (m: Mark): string => {
    const doc = vscode.workspace.textDocuments.find((d) => normalize(d.uri.fsPath) === m.file);
    if (!doc || m.line >= doc.lineCount) return "";
    return doc.lineAt(m.line).text.trim();
  };
  const rel = (file: string): string => {
    const uri = vscode.Uri.file(file);
    return vscode.workspace.asRelativePath(uri, false);
  };
  const toItem = (m: Mark, showFile: boolean): MarkPickItem => ({
    label: `$(bookmark) ${m.name}`,
    description: `${showFile ? rel(m.file) + ":" : "line "}${m.line + 1}`,
    detail: lineText(m) || undefined,
    mark: m,
  });

  if (inActive.length > 0) {
    items.push({ label: "current file", kind: vscode.QuickPickItemKind.Separator, mark: inActive[0] });
    items.push(...inActive.map((m) => toItem(m, false)));
  }
  if (elsewhere.length > 0) {
    items.push({ label: "other files", kind: vscode.QuickPickItemKind.Separator, mark: elsewhere[0] });
    items.push(...elsewhere.map((m) => toItem(m, true)));
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Jump to a Neovim mark",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;
  const m = picked.mark;
  const pos = new vscode.Position(m.line, m.col);
  await vscode.window.showTextDocument(vscode.Uri.file(m.file), {
    selection: new vscode.Range(pos, pos),
    preserveFocus: false,
  });
}

/** Public API returned from `activate`, reachable via `vscode.extensions.getExtension("xbghc.nvim-marks").exports`. */
export interface NvimMarksApi {
  /** All marks currently known, 0-based positions, normalized file keys. */
  marks(): Mark[];
  /** Marks known for one document. */
  marksFor(doc: vscode.TextDocument): Mark[];
  /** Decoration key -> ranges last applied to a document. */
  appliedFor(doc: vscode.TextDocument): Map<string, vscode.Range[]>;
}

export function activate(context: vscode.ExtensionContext): NvimMarksApi {
  const output = vscode.window.createOutputChannel("Neovim Marks");
  const renderer = new MarkRenderer(output);
  output.appendLine(`activated (${process.platform}, cwd ${path.basename(process.cwd())})`);

  context.subscriptions.push(
    output,
    renderer,
    vscode.commands.registerCommand("nvimMarks.update", (payload: unknown) => renderer.update(payload)),
    vscode.commands.registerCommand("nvimMarks.list", () => listMarks(renderer)),
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

  return {
    marks: () => renderer.allMarks,
    marksFor: (doc) => renderer.marksFor(doc),
    appliedFor: (doc) => renderer.appliedFor(doc),
  };
}

export function deactivate(): void {
  // Disposables are handled through context.subscriptions.
}
