/**
 * Integration suite executed inside VS Code by @vscode/test-electron.
 * No mocha: a tiny runner with node:assert keeps dependencies minimal.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import assert from "node:assert/strict";
import type { NvimMarksApi } from "../extension";
import { makeNormalizer, type WirePayload } from "../model";

type TestFn = () => Promise<void> | void;
const tests: Array<[string, TestFn]> = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await sleep(25);
  }
}

const ws = process.env.NVIM_MARKS_TEST_WORKSPACE!;
const fileA = path.join(ws, "a.txt");
const fileB = path.join(ws, "b.txt");
const fileUnicode = path.join(ws, "unicode.txt");
const normalize = makeNormalizer(process.platform);

function activeFileKey(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? normalize(uri.fsPath) : undefined;
}

async function api(): Promise<NvimMarksApi> {
  const ext = vscode.extensions.getExtension<NvimMarksApi>("xbghc.nvim-marks");
  assert.ok(ext, "extension xbghc.nvim-marks is installed in the test instance");
  const exports = await ext.activate();
  assert.ok(exports, "activate() returns the API object");
  return exports;
}

async function useMarkPicker(
  action: "accept" | "cancel",
  payload?: WirePayload,
  beforeClose?: () => void | Promise<void>,
): Promise<void> {
  const command = payload === undefined
    ? vscode.commands.executeCommand("nvimMarks.list")
    : vscode.commands.executeCommand("nvimMarks.list", payload);
  let finished = false;
  // Handle rejection immediately, including if the command fails before the UI opens.
  const result = Promise.resolve(command).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void result.then(() => { finished = true; });

  try {
    // The public API does not expose another extension's QuickPick. Drive it with
    // normal workbench commands and bound completion so a failed picker cannot hang CI.
    await sleep(500);
    if (finished) {
      const outcome = await result;
      if (!outcome.ok) throw outcome.error;
    }
    assert.equal(finished, false, "the list command stays open until the picker is accepted or cancelled");
    await beforeClose?.();
    await vscode.commands.executeCommand(
      action === "accept" ? "workbench.action.acceptSelectedQuickOpenItem" : "workbench.action.closeQuickOpen",
    );
    await waitFor(() => finished, 5000);
    const outcome = await result;
    if (!outcome.ok) throw outcome.error;
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  }
}

test("extension activates and registers its commands", async () => {
  await api();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["nvimMarks.update", "nvimMarks.list", "nvimMarks.toggle", "nvimMarks.status"]) {
    assert.ok(cmds.includes(c), `command ${c} registered`);
  }
});

test("status reports both versions and flags a mismatched half", async () => {
  const a = await api();
  const ext = vscode.extensions.getExtension("xbghc.nvim-marks")!;
  const current = String(ext.packageJSON.version);
  const before = a.status().updates;

  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    plugin_version: current,
    locals: [{ file: fileA, marks: [{ name: "a", line: 1, col: 1 }] }],
    globals: [{ name: "Q", file: fileA, line: 2, col: 1 }],
  });
  let s = a.status();
  assert.equal(s.extensionVersion, current);
  assert.equal(s.updates, before + 1);
  assert.equal(s.pluginVersion, current);
  assert.equal(s.pluginProtocol, 1);
  assert.equal(s.issue, undefined, "a plugin of the same release as the extension is compatible");
  assert.deepEqual([s.localMarks, s.globalMarks], [1, 1]);

  // A plugin from before 0.1.3 does not report its version.
  await vscode.commands.executeCommand("nvimMarks.update", { version: 1, locals: [], globals: [] });
  s = a.status();
  assert.equal(s.pluginVersion, undefined);
  assert.equal(s.issue?.outdated, "plugin");

  // Version reporting alone is not enough: 0.1.3 lacks the backtick mapping.
  await vscode.commands.executeCommand("nvimMarks.update", { version: 1, plugin_version: "0.1.3", locals: [], globals: [] });
  s = a.status();
  assert.equal(s.issue?.outdated, "plugin");
  assert.match(s.issue!.message, /remove any separate nvim-marks installation/);
  assert.match(s.issue!.message, /reload VS Code/);
  await vscode.commands.executeCommand("nvimMarks.update", { version: 1, plugin_version: "0.1.4", locals: [], globals: [] });
  assert.equal(a.status().issue, undefined, "the first plugin with the backtick mapping is compatible");

  await vscode.commands.executeCommand("nvimMarks.update", { version: 99, plugin_version: "99.0.0", locals: [], globals: [] });
  assert.equal(a.status().issue?.outdated, "extension");

  await vscode.commands.executeCommand("nvimMarks.status");
});

test("update command stores marks and decorates the visible editor", async () => {
  const a = await api();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  const editor = await vscode.window.showTextDocument(doc);

  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [{ file: fileA, marks: [{ name: "a", line: 2, col: 1 }, { name: "b", line: 2, col: 4 }, { name: "c", line: 4, col: 1 }] }],
    globals: [{ name: "Q", file: fileA, line: 4, col: 1 }, { name: "Z", file: fileB, line: 1, col: 1 }],
  });

  const marks = a.marksFor(doc);
  assert.deepEqual(
    marks.map((m) => [m.name, m.kind, m.line]),
    [
      ["a", "local", 1],
      ["b", "local", 1],
      ["c", "local", 3],
      ["Q", "global", 3],
    ],
  );
  assert.equal(a.marks().length, 5, "global mark in the other file is kept too");

  await waitFor(() => a.appliedFor(doc).size > 0);
  const applied = a.appliedFor(doc);
  assert.deepEqual([...applied.keys()].sort(), ["global:cQ", "local:ab"]);
  assert.equal(applied.get("local:ab")![0].start.line, 1);
  assert.equal(applied.get("global:cQ")![0].start.line, 3);
  assert.equal(normalize(editor.document.uri.fsPath), normalize(doc.uri.fsPath));
});

test("a later update replaces the previous snapshot", async () => {
  const a = await api();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  await vscode.window.showTextDocument(doc);

  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [{ file: fileA, marks: [{ name: "x", line: 1, col: 1 }] }],
    globals: [],
  });
  assert.deepEqual(a.marksFor(doc).map((m) => m.name), ["x"]);
  await waitFor(() => [...a.appliedFor(doc).keys()].join() === "local:x");
});

test("opening the other file applies its marks without a new update", async () => {
  const a = await api();
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [],
    globals: [{ name: "Z", file: fileB, line: 2, col: 1 }],
  });
  const docB = await vscode.workspace.openTextDocument(vscode.Uri.file(fileB));
  await vscode.window.showTextDocument(docB);
  await waitFor(() => a.appliedFor(docB).has("global:Z"));
  assert.equal(a.appliedFor(docB).get("global:Z")![0].start.line, 1);
});

test("marks beyond the end of the document are skipped, not thrown", async () => {
  const a = await api();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileB));
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [{ file: fileB, marks: [{ name: "a", line: 999, col: 1 }, { name: "b", line: 1, col: 1 }] }],
    globals: [],
  });
  await waitFor(() => a.appliedFor(doc).has("local:b"));
  assert.equal(a.appliedFor(doc).size, 1);
});

test("malformed payloads are tolerated", async () => {
  const a = await api();
  await vscode.commands.executeCommand("nvimMarks.update", "garbage");
  assert.equal(a.marks().length, 0);
  await vscode.commands.executeCommand("nvimMarks.update", undefined);
  assert.equal(a.marks().length, 0);
});

test("toggle hides and re-shows decorations", async () => {
  const a = await api();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [{ file: fileA, marks: [{ name: "k", line: 1, col: 1 }] }],
    globals: [],
  });
  await waitFor(() => a.appliedFor(doc).has("local:k"));
  await vscode.commands.executeCommand("nvimMarks.toggle");
  await waitFor(() => a.appliedFor(doc).size === 0);
  await vscode.commands.executeCommand("nvimMarks.toggle");
  await waitFor(() => a.appliedFor(doc).has("local:k"));
});

test("list command opens a quick pick and jumps on accept", async () => {
  await api();
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    locals: [],
    globals: [{ name: "J", file: fileA, line: 4, col: 3 }],
  });
  const docB = await vscode.workspace.openTextDocument(vscode.Uri.file(fileB));
  await vscode.window.showTextDocument(docB);

  await useMarkPicker("accept");
  await waitFor(() => activeFileKey() === normalize(fileA));
  const sel = vscode.window.activeTextEditor!.selection.active;
  assert.equal(sel.line, 3);
  assert.equal(sel.character, 2);
});

test("list uses its fresh payload before the first selection, replacing the old snapshot", async () => {
  const a = await api();
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  await vscode.window.showTextDocument(docA);
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    plugin_version: a.status().extensionVersion,
    locals: [{ file: fileA, marks: [{ name: "x", line: 1, col: 1 }] }],
    globals: [],
  });
  const before = a.status().updates;

  await useMarkPicker("accept", {
    version: 1,
    plugin_version: a.status().extensionVersion,
    locals: [],
    globals: [{ name: "J", file: fileB, line: 2, col: 2 }],
  }, () => {
    assert.equal(a.status().updates, before + 1, "the fresh payload is received before accepting the picker");
    assert.deepEqual(a.marks().map((m) => m.name), ["J"]);
    assert.deepEqual(a.marksFor(docA), [], "marks missing from the new payload are removed");
  });

  await waitFor(() => activeFileKey() === normalize(fileB));
  const sel = vscode.window.activeTextEditor!.selection.active;
  assert.deepEqual([sel.line, sel.character], [1, 1], "the picker jumps to the fresh mark, not the stale current-file mark");
});

test("cancelling a mark picker preserves the current file and selection", async () => {
  const a = await api();
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  const editor = await vscode.window.showTextDocument(docA);
  const original = new vscode.Selection(3, 4, 1, 2);
  editor.selection = original;

  await useMarkPicker("cancel", {
    version: 1,
    plugin_version: a.status().extensionVersion,
    locals: [],
    globals: [{ name: "J", file: fileB, line: 2, col: 2 }],
  });

  assert.equal(activeFileKey(), normalize(fileA));
  const selection = vscode.window.activeTextEditor!.selection;
  assert.ok(selection.anchor.isEqual(original.anchor), "selection anchor is preserved");
  assert.ok(selection.active.isEqual(original.active), "selection direction and active position are preserved");
});

test("an empty fresh payload opens a dismissible picker without reusing old marks", async () => {
  const a = await api();
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  const editor = await vscode.window.showTextDocument(docA);
  const original = new vscode.Selection(2, 3, 2, 3);
  editor.selection = original;
  await vscode.commands.executeCommand("nvimMarks.update", {
    version: 1,
    plugin_version: a.status().extensionVersion,
    locals: [],
    globals: [{ name: "J", file: fileB, line: 2, col: 2 }],
  });

  await useMarkPicker("cancel", {
    version: 1,
    plugin_version: a.status().extensionVersion,
    locals: [],
    globals: [],
  }, () => {
    assert.equal(a.marks().length, 0, "an empty payload also replaces the old snapshot");
  });

  assert.equal(activeFileKey(), normalize(fileA));
  assert.ok(vscode.window.activeTextEditor!.selection.active.isEqual(original.active));
});

test("mark jumps translate Neovim byte columns correctly across Chinese text and emoji", async () => {
  const a = await api();
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  // In "甲😀乙 target", the emoji starts at byte column 4 and "target" at 12.
  // Their VS Code UTF-16 character offsets are 1 and 5 respectively.
  for (const [wireColumn, character, target] of [[4, 1, "😀"], [12, 5, "target"]] as const) {
    await vscode.window.showTextDocument(docA);
    await useMarkPicker("accept", {
      version: 1,
      plugin_version: a.status().extensionVersion,
      locals: [],
      globals: [{ name: "U", file: fileUnicode, line: 2, col: wireColumn }],
    });

    await waitFor(() => activeFileKey() === normalize(fileUnicode));
    const editor = vscode.window.activeTextEditor!;
    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [1, character]);
    assert.equal(editor.document.getText(new vscode.Range(1, character, 1, character + target.length)), target);
  }
});

test("mark jumps clamp stale line and column positions to the document", async () => {
  const a = await api();
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(fileA));
  for (const [wireLine, expectedLine] of [[2, 1], [999, 2]] as const) {
    await vscode.window.showTextDocument(docA);
    await useMarkPicker("accept", {
      version: 1,
      plugin_version: a.status().extensionVersion,
      locals: [],
      globals: [{ name: "J", file: fileB, line: wireLine, col: 999 }],
    });

    await waitFor(() => activeFileKey() === normalize(fileB));
    const editor = vscode.window.activeTextEditor!;
    const end = editor.document.lineAt(expectedLine).range.end;
    assert.ok(editor.selection.active.isEqual(end), "an out-of-range mark lands at the valid line end");
  }
});

export async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${(err as Error).stack ?? err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) throw new Error(`${failed} integration test(s) failed`);
}
