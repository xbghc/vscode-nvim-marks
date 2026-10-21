/** Runs in a real VS Code extension host with the installed vscode-neovim. */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import type { NvimMarksApi } from "../extension";
import { makeNormalizer } from "../model";

// _getNeovimClient is registered by vscode-neovim itself. This is its real RPC
// client, used only to arrange native marks and inspect state; nothing is mocked.
interface NeovimClient {
  executeLua<T = unknown>(code: string, args: unknown[]): Promise<T>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const normalize = makeNormalizer(process.platform);

async function bounded<T>(operation: Thenable<T>, label: string, ms = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await bounded(Promise.resolve(predicate()), label, ms))) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await sleep(25);
  }
}

export async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const testRoot = process.env.NVIM_MARKS_NEOVIM_TEST_ROOT!;
  const file = path.join(process.env.NVIM_MARKS_TEST_WORKSPACE!, "marks.txt");
  const results: string[] = [];
  try {
    const marksExtension = vscode.extensions.getExtension<NvimMarksApi>("xbghc.nvim-marks");
    const neovimExtension = vscode.extensions.getExtension("asvetliakov.vscode-neovim");
    assert.ok(marksExtension, "Neovim Marks is loaded as a development extension");
    assert.ok(neovimExtension, "the real installed vscode-neovim is available");
    const marks = await bounded(marksExtension.activate(), "activate Neovim Marks", 20000);
    await bounded(neovimExtension.activate(), "activate vscode-neovim", 20000);
    await waitFor(async () => (await vscode.commands.getCommands()).includes("_getNeovimClient"), "Neovim RPC command registration");
    let client = await bounded(vscode.commands.executeCommand<NeovimClient>("_getNeovimClient"), "get live Neovim client");
    assert.equal(typeof client?.executeLua, "function", "vscode-neovim exposes its live RPC client");
    const lua = <T = unknown>(code: string, args: unknown[] = []) => bounded(client.executeLua<T>(code, args), "Neovim RPC");
    await waitFor(() => marks.status().bridge === "bundled Lua loaded" && marks.status().updates > 0, "automatic bundled Lua startup");
    assert.deepEqual(await lua("return vim.api.nvim_get_runtime_file('lua/nvim-marks/init.lua', true)"), [],
      "no separately installed Lua plugin or runtime path is needed");
    assert.equal(await lua("return vim.fn.isdirectory(vim.fn.stdpath('config'))"), 0, "no Neovim config directory was created");
    results.push("bundled Lua starts without a plugin installation or Neovim configuration changes");
    passed++;
    console.log(`ok   ${results[results.length - 1]}`);
    const send = (keys: string) => bounded(vscode.commands.executeCommand("vscode-neovim.send", keys), "send Neovim keys");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await waitFor(async () => normalize(await lua<string>("return vim.api.nvim_buf_get_name(0)")) === normalize(file), "Neovim document attachment");
    await waitFor(async () => await lua<string>("return vim.fn.mode()") === "n", "normal mode");
    assert.equal(await lua<string>("return vim.bo.buftype"), "acwrite", "exercise a genuine vscode-neovim document buffer");
    assert.equal(await lua<string>("return vim.fn.maparg('`', 'n', false, true).desc"), "List Neovim marks");
    const nvimArguments = await lua<string[]>("return vim.v.argv");
    const initIndex = nvimArguments.indexOf("-u");
    assert.ok(initIndex >= 0, "Neovim uses an explicit isolated init");
    assert.equal(normalize(nvimArguments[initIndex + 1]), normalize(path.join(process.env.NVIM_MARKS_REPOSITORY!, "test", "vscode-neovim", "init.lua")));
    const originalText = document.getText();
    const assertUnchanged = (): void => {
      assert.equal(document.getText(), originalText, "backtick and picker actions do not edit document text");
      assert.equal(document.isDirty, false, "the document stays unmodified");
    };
    const cursorAt = (line: number, character: number): boolean => {
      const editor = vscode.window.activeTextEditor;
      return !!editor && normalize(editor.document.uri.fsPath) === normalize(file)
        && editor.selection.isEmpty && editor.selection.active.line === line && editor.selection.active.character === character;
    };
    const snapshot = () => marks.marksFor(document).map(({ name, line, col }) => [name, line, col]);

    // Seed a genuinely received old snapshot. Moving the native mark below does
    // not call refresh: only the bare-backtick mapping can deliver the new one.
    await lua("vim.cmd('delmarks a-zA-Z'); vim.api.nvim_buf_set_mark(0, 'a', 1, 0, {}); require('nvim-marks').refresh()");
    await waitFor(() => marks.status().updates > 0 && marks.marksFor(document)[0]?.line === 0, "initial real bridge snapshot");
    assert.equal(marks.status().pluginVersion, marks.status().extensionVersion);
    assert.equal(marks.status().issue, undefined);
    await send("gg0");
    await waitFor(() => cursorAt(0, 0), "initial cursor");
    await lua("vim.api.nvim_buf_set_mark(0, 'a', 4, 6, {})");
    assert.deepEqual(snapshot(), [["a", 0, 0]], "VS Code still has the old mark before pressing backtick");
    let before = marks.status().updates;
    await send("`");
    await waitFor(() => marks.status().updates > before, "bare backtick delivers a fresh picker snapshot through the real bridge");
    assert.equal(marks.status().updates, before + 1, "the picker carries one snapshot without a separate update RPC");
    assert.deepEqual(snapshot(), [["a", 3, 6]], "the picker snapshot contains the newly moved native mark");
    await sleep(250);
    await bounded(vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem"), "accept mark picker");
    await waitFor(() => cursorAt(3, 6), "accept jumps to the fresh mark");
    await waitFor(async () => {
      const position = await lua<number[]>("return vim.api.nvim_win_get_cursor(0)");
      return position[0] === 4 && position[1] === 6;
    }, "accepted selection synchronizes back into Neovim");
    assertUnchanged();
    results.push("bare backtick uses the real bridge, refreshes the snapshot and jumps on accept");
    passed++;
    console.log(`ok   ${results[results.length - 1]}`);

    await send("gg0");
    await waitFor(() => cursorAt(0, 0), "cursor before cancel");
    await lua("vim.api.nvim_buf_set_mark(0, 'a', 2, 2, {})");
    assert.deepEqual(snapshot(), [["a", 3, 6]], "cancel test also starts with a stale received snapshot");
    before = marks.status().updates;
    await send("`");
    await waitFor(() => marks.status().updates > before, "second bare backtick reaches the picker");
    assert.equal(marks.status().updates, before + 1);
    assert.deepEqual(snapshot(), [["a", 1, 2]], "cancel picker receives fresh marks too");
    await sleep(250);
    await bounded(vscode.commands.executeCommand("workbench.action.closeQuickOpen"), "cancel mark picker");
    await sleep(250);
    assert.ok(cursorAt(0, 0), "cancel keeps the original document and cursor");
    assertUnchanged();
    await send("j");
    await waitFor(() => cursorAt(1, 0), "normal-mode input still works after cancellation");
    assertUnchanged();
    results.push("cancelling the real backtick picker preserves text and cursor, and normal input resumes");
    passed++;
    console.log(`ok   ${results[results.length - 1]}`);

    before = marks.status().updates;
    await bounded(vscode.commands.executeCommand("vscode-neovim.restart"), "restart the real Neovim bridge", 20000);
    await waitFor(async () => (await vscode.commands.getCommands()).includes("_getNeovimClient"), "restarted Neovim RPC command registration", 20000);
    client = await bounded(vscode.commands.executeCommand<NeovimClient>("_getNeovimClient"), "get restarted Neovim client");
    await waitFor(() => marks.status().updates > before, "automatically reload Lua after Neovim restarts", 15000);
    assert.equal(await lua("return vim.fn.maparg('`', 'n', false, true).desc"), "List Neovim marks");
    assert.equal(marks.status().pluginVersion, marks.status().extensionVersion);
    results.push("restarting vscode-neovim automatically restores the bundled module and mappings");
    passed++;
    console.log(`ok   ${results[results.length - 1]}`);

    const settings = vscode.workspace.getConfiguration("nvimMarks");
    await settings.update("mapM", false, vscode.ConfigurationTarget.Global);
    await settings.update("mapBacktick", false, vscode.ConfigurationTarget.Global);
    await waitFor(async () => await lua("return vim.fn.maparg('`', 'n', false, true).desc") === "Original user backtick", "apply shortcut settings");
    assert.equal(await lua("return vim.fn.maparg('m', 'n', false, true).desc"), "Original user m");
    await settings.update("mapM", true, vscode.ConfigurationTarget.Global);
    await settings.update("mapBacktick", true, vscode.ConfigurationTarget.Global);
    await waitFor(async () => await lua("return vim.fn.maparg('`', 'n', false, true).desc") === "List Neovim marks", "re-enable shortcuts");
    assert.equal(await lua("return #vim.api.nvim_get_autocmds({group='NvimMarksSync'})"), 7, "reconfiguration does not duplicate autocmds");
    const lifecycle = require(path.join(marksExtension.extensionPath, "dist/extension.js")) as { deactivate(): Promise<void> };
    await bounded(lifecycle.deactivate(), "deactivate Neovim Marks");
    assert.equal(await lua("return package.loaded['nvim-marks'] == nil"), true);
    assert.equal(await lua("return vim.fn.exists('#NvimMarksSync')"), 0);
    assert.equal(await lua("return vim.fn.exists(':NvimMarksRefresh')"), 0);
    assert.equal(await lua("return vim.fn.maparg('m', 'n', false, true).desc"), "Original user m");
    assert.equal(await lua("return vim.fn.maparg('`', 'n', false, true).desc"), "Original user backtick");
    assert.equal(await lua("return vim.fn.isdirectory(vim.fn.stdpath('config'))"), 0);
    await sleep(5500);
    assert.equal(await lua("return package.loaded['nvim-marks'] == nil"), true, "deactivation stops automatic reinstallation");
    results.push("VS Code settings reconfigure mappings; deactivation cleans the session and restores user mappings");
    passed++;
    console.log(`ok   ${results[results.length - 1]}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${error instanceof Error ? error.stack : error}`);
    throw error;
  } finally {
    await bounded(vscode.commands.executeCommand("workbench.action.closeQuickOpen"), "close remaining picker", 2000).catch(() => {});
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify({ passed, failed, results }, null, 2));
    console.log(`\n${passed}/5 real Neovim E2E tests passed`);
  }
}
