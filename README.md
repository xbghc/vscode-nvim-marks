# Neovim Marks for VS Code

Shows your Neovim marks in the VS Code gutter when you use
[vscode-neovim](https://github.com/vscode-neovim/vscode-neovim).

vscode-neovim forces `signcolumn=no`, so plugins that draw marks in the sign
column render nothing inside VS Code. This project fills that gap without
moving marks out of Neovim: `ma`, `'a`, `d'a`, `:'a,'bs/…/…/`, `:marks` and
`:delmarks` keep their native behaviour. In normal mode, press backtick (`` ` ``)
to preview your marks, then a mark key to jump directly, for example `` `a ``.

The extension bundles both halves and loads Lua automatically:

- a **Neovim plugin** (`lua/nvim-marks/`) that snapshots marks and pushes them
  to VS Code through `require("vscode").action(...)`;
- a **VS Code extension** (`src/`) that receives the snapshot and renders gutter
  icons, end-of-line labels and overview-ruler markers, plus a QuickPick to jump.

## Installation

Install the `.vsix` from the [releases page](https://github.com/xbghc/vscode-nvim-marks/releases)
or build it yourself. VS Code installs the required **vscode-neovim** extension
as a dependency; its Neovim executable must still be installed and configured.

```sh
npm install
npm run package          # produces nvim-marks-<version>.vsix
code --install-extension nvim-marks-<version>.vsix
```

No separate Neovim plugin or `require("nvim-marks").setup()` is needed.
The bundled Lua runs only in the Neovim session managed by vscode-neovim.

### Upgrading from the separate Neovim plugin

Remove the `xbghc/vscode-nvim-marks` entry from lazy.nvim (or your plugin
manager) and any manual `require("nvim-marks").setup(...)` call, then reload
the VS Code window. Move custom options to the VS Code settings below. If an
old module is already loaded, the extension explains this migration instead
of starting a second copy. It does not edit your existing configuration.

### Uninstalling

Uninstall **Neovim Marks** from VS Code and reload the window if prompted.
The Lua file is removed with the extension. Nothing is written to your Neovim
configuration or plugin directories, so no uninstall hook is needed. When the
extension deactivates while Neovim is still running, it removes its timers,
autocmds, command and mappings, restoring any mappings it temporarily replaced.
User mappings changed afterward are preserved. Native marks remain in Neovim.

## Usage

Set marks as usual. They appear in the gutter within a few milliseconds:
both lowercase (local) and uppercase (global) marks appear as plain bold
letters without a border. When several marks sit on one line the icon shows the first
two letters, or one letter and `+`.

Lowercase marks belong to their file. If VS Code replaces a preview tab or
recreates a document buffer, the extension restores that file's local marks
when it reopens in the same Neovim session. Native jumps still work, and marks
removed with `:delmarks` stay deleted. This recovery data is held in memory;
it does not provide persistence across Neovim restarts.

Press **backtick (`` ` ``)** in normal mode to preview the mark list, then the mark
letter to jump directly to its exact line and column. For example, `` `a `` jumps to local mark
`a` and `` `A `` jumps to global mark `A`, including in another file. Focus stays
in the editor: the next key selects a mark instead of searching, and no **Enter**
is needed. The preview closes after the key; **Esc** closes it without jumping.
It shows local marks in the current file and global marks across files. Native
special marks and the jumplist still work.

For a searchable list, run **Neovim Marks: List marks** from the Command Palette.
It uses the same native VS Code UI as Quick Open (`Cmd+P` / `Ctrl+P`). Each item
occupies one line: the mark letter, one space, then the source text, with the file path and
`line:column` alongside. For documents that are not open, the file name replaces
the source text. Marks in the current file come first, followed by other files.
Type to filter by mark, file, path, position or source text, use the arrow keys
to select a result, then press **Enter** to jump. **Esc** closes the picker
without moving the cursor. With no marks, the picker explains how to set one.

The backtick shortcut refreshes decorations when pressed and jumps using Neovim's
live marks, so a just-created or moved mark works before the usual debounced update.

Locations use Neovim's 1-based line and byte column. When jumping, columns are
converted to VS Code's character offsets, including on lines with non-ASCII
text. In a multi-root workspace, paths include the workspace folder name.

The default normal-mode backtick mapping previews marks while preserving native
backtick-prefixed jumps. Set `nvimMarks.mapBacktick` to `false` in VS Code to leave
your own backtick mapping untouched and skip the preview. Insert mode,
visual mode and operator-pending motions such as `` d`a `` stay native.

Commands (Command Palette):

- **Neovim Marks: List marks** — QuickPick of all known marks, grouped into the
  current file and other files; accepting jumps to the mark.
- **Neovim Marks: Toggle mark decorations** — hide or show the decorations
  without touching Neovim.
- **Neovim Marks: Show status** — print the versions of both halves, the number
  of marks received and the active settings to the "Neovim Marks" output
  channel. Start here when marks do not show up.

Both halves update together with the extension. **Show status** also reports
whether the bundled Lua has loaded and any startup errors.

Neovim side:

- `:NvimMarksRefresh` — resend all marks, e.g. after reloading the VS Code
  window.
- `require("nvim-marks").sync(true)` — same thing from Lua.
- `require("nvim-marks").list()` — open the picker with a fresh snapshot.

### Settings

| Setting                      | Default                                  | Meaning                                                   |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `nvimMarks.mapM`             | `true`                                   | Sync immediately after setting a mark with `m`.          |
| `nvimMarks.mapBacktick`      | `true`                                   | Preview marks, then jump directly on the mark key.       |
| `nvimMarks.debounceMs`       | `60`                                     | Combine bursts of updates within this many milliseconds. |
| `nvimMarks.extraEvents`      | `[]`                                     | Additional Neovim autocmd events that trigger a sync.    |
| `nvimMarks.enabled`          | `true`                                   | Render marks at all.                                      |
| `nvimMarks.style`            | `"gutter"`                               | `gutter`, `eol` (text after the line) or `both`.          |
| `nvimMarks.overviewRuler`    | `true`                                   | Also mark lines in the scrollbar.                         |
| `nvimMarks.showLocalMarks`   | `true`                                   | Show `a`–`z`.                                             |
| `nvimMarks.showGlobalMarks`  | `true`                                   | Show `A`–`Z`.                                             |
| `nvimMarks.localColor`       | `{ light: "#4d4d4d", dark: "#bdbdbd" }`  | Letter colour for lowercase marks, per theme kind.        |
| `nvimMarks.globalColor`      | `{ light: "#1a1a1a", dark: "#f2f2f2" }`  | Letter colour for uppercase marks, per theme kind.        |

These settings apply to the current Neovim session without editing its init file:

```json
{
  "nvimMarks.mapM": true,
  "nvimMarks.mapBacktick": true,
  "nvimMarks.debounceMs": 60,
  "nvimMarks.extraEvents": []
}
```

With `nvimMarks.mapM` set to `false`, marks still sync, but only on the next `CursorHold`,
`BufEnter`, `TextChanged`, `InsertLeave`, `BufWritePost` or command-line
event.

## How it works

The extension sends its bundled Lua source through the public
`vscode-neovim.lua` command. It does not depend on a shared filesystem path
between VS Code and Neovim. A small probe every five seconds detects Neovim
restarts and loads the module into the new session automatically.

1. On the triggers above, Lua collects `a`–`z` marks via `getmarklist(buf)`
   and `A`–`Z` marks via `getmarklist()`, with absolute file paths and 1-based
   positions. It retains local marks before a document buffer is unloaded or
   wiped, includes saved marks for unloaded buffers in snapshots, and restores
   native marks when the file is loaded again.
2. If the snapshot differs from the last one it is sent with
   `vscode.action("nvimMarks.update", { args = { payload } })`.
3. The extension normalizes paths, converts to 0-based positions and groups
   marks per line. Each distinct label (`a`, `aB`, `c+`, …) gets its own
   `TextEditorDecorationType` whose gutter icon is an inline SVG data URI, so
   the extension ships no image files and can colour icons per theme.
4. Decorations are re-applied whenever the set of visible editors changes, so
   split views and newly opened tabs pick up their marks from the stored
   snapshot without another round trip.

Between pushes VS Code shifts decoration ranges with edits on its own; the next
push from Neovim corrects any drift.

## Limitations

- VS Code draws one gutter icon per line. Multiple marks on a line are
  combined into one icon (`ab`, `a+`).
- The gutter is shared with breakpoints and git decorations; there is no
  dedicated column as in Neovim.
- Marks are only visible, not editable, from the VS Code side. Use Neovim to
  set and delete them.
- Payload path: `vim.g.vscode` must be set, i.e. Neovim must run inside
  vscode-neovim.

## Development

```sh
npm install
npm test             # typecheck + unit tests (node:test)
npm run test:vscode  # integration tests in a real VS Code (xvfb-run -a on Linux)
npm run test:lua     # headless Neovim test of the Lua plugin (needs nvim)
npm run test:neovim  # real vscode-neovim bridge test (see below)
npm run package      # build the .vsix
```

The bridge test uses an installed `asvetliakov.vscode-neovim` extension, an
isolated VS Code profile and a minimal Neovim config with no nvim-marks setup.
It covers automatic loading, preview focus, direct mark jumps, cancellation,
preview-tab switching, restart recovery, settings and deactivation cleanup. The renderer-only `test:vscode` suite uses a test fixture
for the dependency and injects snapshots directly.
Set `NVIM_MARKS_NEOVIM_EXTENSION` to the installed extension directory when it
is not under `~/.vscode/extensions`. Set `VSCODE_EXECUTABLE_PATH` to a local
VS Code executable to run either VS Code test suite without downloading it.
Set `NVIM_MARKS_NEOVIM_EXECUTABLE` to an absolute Neovim executable path if
VS Code's environment does not find the same `nvim` as your shell.

### Backtick does nothing

1. Update **Neovim Marks** in VS Code (choose **Switch to Pre-Release Version**
   for the 0.1.x releases), or install the VSIX from GitHub Releases.
2. Remove any old separate nvim-marks installation and setup call from your
   Neovim configuration, following the migration instructions above.
3. Run **Developer: Reload Window** in VS Code. In **Normal mode**, set a mark
   with `ma`, move elsewhere, then press backtick followed by `a`.
   A preview should open on backtick, then close as `a` jumps directly to the mark.
4. Use **Neovim Marks: Show status** to check the Lua bridge. Confirm
   vscode-neovim is running; use **Neovim: Restart Extension** if needed.
   Check `:verbose nmap <Char-96>` for another mapping. `nvimMarks.mapBacktick`
   controls the preview; native jumps also work with it disabled.

## License

MIT
