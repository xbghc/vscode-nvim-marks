-- Isolated init for the opt-in real vscode-neovim bridge test.
-- The runner supplies a temporary XDG directory and never loads the user's init.
vim.opt.shadafile = "NONE"
vim.opt.shada = ""
vim.opt.loadplugins = false
vim.opt.packpath = ""
vim.opt.updatetime = 60000
-- No nvim-marks runtime path, plugin installation or setup call: the VS Code
-- extension must supply everything. User mappings must survive its teardown.
vim.keymap.set("n", "m", "m", { desc = "Original user m" })
vim.keymap.set("n", "`", "`", { desc = "Original user backtick" })
