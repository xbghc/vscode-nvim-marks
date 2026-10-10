# Changelog

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
