# Changelog

## 0.1.6 (pre-release)

- Bundle and automatically load the Lua module through vscode-neovim, including after Neovim restarts. No separate plugin installation or Neovim configuration is needed.
- Add VS Code settings for the mark and backtick mappings, debounce delay and additional sync events.
- Clean up session resources and restore previous mappings on deactivation. Uninstalling removes the bundled Lua with the extension without touching user configuration.
- Declare vscode-neovim as an extension dependency and explain migration from separately installed Lua plugins.

## 0.1.5 (pre-release)

- Warn when the Neovim plugin predates 0.1.4 and cannot provide the backtick mark picker; explain how to update it and reload VS Code.
- Add an opt-in integration test through the real vscode-neovim bridge, covering backtick input, fresh marks, jumps and cancellation.
- Run Lua tests directly on Windows without WSL, and normalize Windows paths in the VS Code test assertions.

## 0.1.4 (pre-release)

- Press backtick in normal mode to open the native VS Code mark picker with a fresh Neovim snapshot. Set `map_backtick = false` to retain native normal-mode backtick jumps.
- Every picker item shows the mark, file name, path, line and column, with searchable source text for open documents. Multi-root workspace paths include the folder name.
- Keep the picker available when no marks exist, and show an actionable message when a marked file cannot be opened.
- Correct mark jumps on lines with non-ASCII text by converting Neovim's UTF-8 byte columns to VS Code's UTF-16 offsets; clamp stale positions to the document bounds.
- Exclude downloaded Neovim test binaries from the VSIX package.

## 0.1.3 (pre-release)

- The Neovim plugin reports its version with every payload; the extension warns once when the plugin is outdated or the two halves speak different protocol versions.
- `Neovim Marks: Show status` prints both versions, mark counts and the active settings to the output channel.

## 0.1.2 (pre-release)

- Fix: lowercase (buffer-local) marks were not shown under vscode-neovim, whose document buffers use `buftype=acwrite`.

## 0.1.1 (pre-release)

- Marketplace icon.
- Release workflow: tag-triggered and manual runs, pre-release support.
- Toolchain updated (TypeScript 7, esbuild 0.28, vsce 4).

## 0.1.0

- Initial release.
- Gutter icons, end-of-line labels and overview-ruler markers for Neovim marks.
- `Neovim Marks: List marks` QuickPick with jump.
- `Neovim Marks: Toggle mark decorations`.
- Neovim plugin `nvim-marks` with debounced sync, `m` wrapper and `:NvimMarksRefresh`.
