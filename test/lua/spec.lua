-- Headless test for lua/nvim-marks/init.lua.
-- Run with:  nvim --headless -u NONE -l test/lua/spec.lua
-- A fake `vscode` module records every action so the payload can be asserted
-- without VS Code.

local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
vim.opt.runtimepath:prepend(root)

local actions = {}
package.preload["vscode"] = function()
  return {
    action = function(name, opts)
      actions[#actions + 1] = { name = name, args = opts and opts.args or {} }
    end,
  }
end

vim.g.vscode = true

local failures = 0
local function check(cond, msg)
  if cond then
    io.stdout:write("ok   " .. msg .. "\n")
  else
    failures = failures + 1
    io.stdout:write("FAIL " .. msg .. "\n")
  end
end

local function wait_for(pred, ms)
  return vim.wait(ms or 1000, pred, 10)
end

local function last_payload()
  local a = actions[#actions]
  return a and a.args[1] or nil
end

local function find(list, name)
  for _, m in ipairs(list or {}) do
    if m.name == name then
      return m
    end
  end
  return nil
end

-- Two real files so buffer names are absolute paths.
local tmp = vim.fn.tempname()
vim.fn.mkdir(tmp, "p")
local file_a = tmp .. "/a.txt"
local file_b = tmp .. "/b.txt"
vim.fn.writefile({ "line1", "line2", "line3", "line4", "line5" }, file_a)
vim.fn.writefile({ "x1", "x2", "x3" }, file_b)

local marks = require("nvim-marks")
marks.setup({ debounce_ms = 5 })

-- 1. initial push happens after setup
check(wait_for(function() return #actions >= 1 end), "initial sync is sent after setup")
check(actions[1] and actions[1].name == "nvimMarks.update", "initial sync targets nvimMarks.update")
local p0 = last_payload()
check(p0 and p0.version == 1 and type(p0.locals) == "table" and type(p0.globals) == "table", "payload has version/locals/globals")

-- 2. setting a local mark through the wrapped `m` triggers a push
vim.cmd("edit " .. file_a)
vim.wait(50)
local n = #actions
vim.api.nvim_win_set_cursor(0, { 3, 2 })
vim.api.nvim_feedkeys("ma", "x", false)
check(wait_for(function() return #actions > n end), "`ma` triggers a sync")
local p = last_payload()
local entry = p and p.locals[1]
check(entry and entry.file == vim.fn.fnamemodify(file_a, ":p"), "local entry carries absolute file path")
local ma = entry and find(entry.marks, "a")
check(ma and ma.line == 3 and ma.col == 3, "mark a is at line 3 col 3 (1-based)")
check(vim.fn.getpos("'a")[2] == 3, "native mark 'a still exists in Neovim")

-- 3. a global mark is reported with its file
n = #actions
vim.api.nvim_win_set_cursor(0, { 5, 0 })
vim.api.nvim_feedkeys("mB", "x", false)
check(wait_for(function() return #actions > n end), "`mB` triggers a sync")
p = last_payload()
local mB = find(p.globals, "B")
check(mB and mB.file == vim.fn.fnamemodify(file_a, ":p") and mB.line == 5, "global mark B reported with file and line")

-- 4. no change -> no resend
n = #actions
marks.sync(false)
check(#actions == n, "sync() without changes does not resend")
marks.refresh()
check(#actions == n + 1, "refresh() always resends")

-- 5. :delmarks removes the mark on the next sync
n = #actions
vim.cmd("delmarks a")
marks.sync(false)
p = last_payload()
check(#actions == n + 1 and (p.locals[1] == nil or find(p.locals[1].marks, "a") == nil), ":delmarks a removes mark a from payload")

-- 6. marks in a second buffer are included while the buffer stays loaded
vim.cmd("edit " .. file_b)
vim.api.nvim_win_set_cursor(0, { 2, 0 })
vim.api.nvim_feedkeys("mc", "x", false)
vim.wait(50)
marks.sync(true)
p = last_payload()
local seen = {}
for _, e in ipairs(p.locals) do
  seen[e.file] = e
end
check(seen[vim.fn.fnamemodify(file_b, ":p")] ~= nil, "marks of the second buffer are included")
check(find(p.globals, "B") ~= nil, "global mark B survives switching buffers")

-- 6b. vscode-neovim document buffers are buftype=acwrite; their local marks must still be sent
vim.bo.buftype = "acwrite"
marks.sync(true)
p = last_payload()
local acwrite_entry = nil
for _, e in ipairs(p.locals) do
  if e.file == vim.fn.fnamemodify(file_b, ":p") then
    acwrite_entry = e
  end
end
check(acwrite_entry ~= nil and find(acwrite_entry.marks, "c") ~= nil, "local marks of a buftype=acwrite buffer are included")

-- 7. special marks are never sent
local ok_special = true
for _, e in ipairs(p.locals) do
  for _, m in ipairs(e.marks) do
    if not m.name:match("^[a-z]$") then ok_special = false end
  end
end
for _, m in ipairs(p.globals) do
  if not m.name:match("^[A-Z]$") then ok_special = false end
end
check(ok_special, "only a-z and A-Z marks are sent")

-- 8. outside VS Code, setup is a no-op and does not require the vscode module
package.loaded["nvim-marks"] = nil
package.loaded["vscode"] = nil
package.preload["vscode"] = nil
vim.g.vscode = nil
local ok = pcall(function() require("nvim-marks").setup({}) end)
check(ok, "setup() outside VS Code does not error")

vim.fn.delete(tmp, "rf")
io.stdout:write(string.format("\n%d failure(s)\n", failures))
os.exit(failures == 0 and 0 or 1)
