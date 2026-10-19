# Neovim Marks for VS Code

Shows your Neovim marks in the VS Code gutter when you use
[vscode-neovim](https://github.com/vscode-neovim/vscode-neovim).

vscode-neovim forces `signcolumn=no`, so plugins that draw marks in the sign
column render nothing inside VS Code. This project fills that gap without
moving marks out of Neovim: `ma`, `'a`, `d'a`, `:'a,'bs/…/…/`, `:marks` and
`:delmarks` keep their native behaviour. Press the backtick key (`` ` ``) in
normal mode to open a VS Code Quick Pick of your marks and jump to a location.

The repository contains two halves that are installed separately:

- a **Neovim plugin** (`lua/nvim-marks/`) that snapshots marks and pushes them
  to VS Code through `require("vscode").action(...)`;
- a **VS Code extension** (`src/`) that receives the snapshot and renders gutter
  icons, end-of-line labels and overview-ruler markers, plus a QuickPick to jump.

## Installation

### 1. VS Code extension

Install the `.vsix` from the [releases page](https://github.com/xbghc/vscode-nvim-marks/releases)
or build it yourself:

```sh
npm install
npm run package          # produces nvim-marks-<version>.vsix
code --install-extension nvim-marks-<version>.vsix
```

### 2. Neovim plugin

With lazy.nvim:

```lua
{
  "xbghc/vscode-nvim-marks",
  cond = vim.g.vscode ~= nil,
  opts = {},
}
```

Outside VS Code `setup()` is a no-op, so the plugin is safe to keep in a shared
config; the `cond` just avoids loading it at all in terminal Neovim.

## Usage

Set marks as usual. They appear in the gutter within a few milliseconds:
lowercase marks as a plain letter, uppercase (global) marks as a letter inside
a rounded frame. When several marks sit on one line the icon shows the first
two letters, or one letter and `+`.

Press **backtick (`` ` ``)** in normal mode to open the mark picker, using the
same native VS Code UI as Quick Open (`Cmd+P` / `Ctrl+P`). Every mark shows its
letter, file name, path and `line:column`; marks in the current file come first,
followed by marks in other files. Source text is included for open documents.
Type to filter by mark, file, path, position or source text, use the arrow keys
to select a result, then press **Enter** to jump. **Esc** closes the picker
without moving the cursor. With no marks, the picker explains how to set one.

The shortcut collects the latest marks when pressed, so it also picks up a
just-created or moved mark before the usual debounced update. Both the VS Code
extension and the Neovim plugin need to be updated to get this shortcut.

Locations use Neovim's 1-based line and byte column. When jumping, columns are
converted to VS Code's character offsets, including on lines with non-ASCII
text. In a multi-root workspace, paths include the workspace folder name.

The default normal-mode backtick mapping replaces native backtick-prefixed
jumps such as `` `a ``. Set `map_backtick = false` in the Neovim plugin options to keep those
bindings and use the **Neovim Marks: List marks** command instead. Insert mode,
visual mode and operator-pending motions such as `` d`a `` stay native.

Commands (Command Palette):

- **Neovim Marks: List marks** — QuickPick of all known marks, grouped into the
  current file and other files; accepting jumps to the mark.
- **Neovim Marks: Toggle mark decorations** — hide or show the decorations
  without touching Neovim.
- **Neovim Marks: Show status** — print the versions of both halves, the number
  of marks received and the active settings to the "Neovim Marks" output
  channel. Start here when marks do not show up.

The two halves are updated separately. The Neovim plugin sends its version with
every payload, and the extension warns once when the plugin is older than it
expects or when the two speak different protocol versions.

Neovim side:

- `:NvimMarksRefresh` — resend all marks, e.g. after reloading the VS Code
  window.
- `require("nvim-marks").sync(true)` — same thing from Lua.
- `require("nvim-marks").list()` — open the picker with a fresh snapshot.

### Settings

| Setting                      | Default                                  | Meaning                                                   |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `nvimMarks.enabled`          | `true`                                   | Render marks at all.                                      |
| `nvimMarks.style`            | `"gutter"`                               | `gutter`, `eol` (text after the line) or `both`.          |
| `nvimMarks.overviewRuler`    | `true`                                   | Also mark lines in the scrollbar.                         |
| `nvimMarks.showLocalMarks`   | `true`                                   | Show `a`–`z`.                                             |
| `nvimMarks.showGlobalMarks`  | `true`                                   | Show `A`–`Z`.                                             |
| `nvimMarks.localColor`       | `{ light: "#4d4d4d", dark: "#bdbdbd" }`  | Letter colour for lowercase marks, per theme kind.        |
| `nvimMarks.globalColor`      | `{ light: "#1a1a1a", dark: "#f2f2f2" }`  | Letter colour for uppercase marks, per theme kind.        |

Neovim `setup()` options:

```lua
require("nvim-marks").setup({
  map_m = true,          -- wrap `m` so a new mark shows up immediately
  map_backtick = true,   -- open the mark picker with ` in normal mode
  debounce_ms = 60,      -- coalesce bursts of events into one push
  extra_events = {},     -- additional autocmd events that trigger a sync
  command = "nvimMarks.update",
})
```

With `map_m = false` marks still sync, but only on the next `CursorHold`,
`BufEnter`, `TextChanged`, `InsertLeave`, `BufWritePost` or command-line
event.

## How it works

1. On the triggers above, Lua collects `a`–`z` marks of every loaded buffer via
   `getmarklist(buf)` and `A`–`Z` marks via `getmarklist()`, with absolute
   file paths and 1-based positions.
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
npm run package      # build the .vsix
```

## License

MIT
