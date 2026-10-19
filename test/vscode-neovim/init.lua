-- Isolated init for the opt-in real vscode-neovim bridge test.
-- The runner supplies a temporary XDG directory and never loads the user's init.
vim.opt.shadafile = "NONE"
vim.opt.shada = ""
vim.opt.loadplugins = false
vim.opt.packpath = ""
vim.opt.updatetime = 60000
vim.opt.runtimepath:prepend(assert(vim.env.NVIM_MARKS_REPOSITORY))

-- Keep automatic updates outside the test window so a moved mark must reach
-- VS Code in the picker RPC itself. The normal-mode mappings remain defaults.
require("nvim-marks").setup({ debounce_ms = 60000 })
