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

local function action_count(name)
  local count = 0
  for _, a in ipairs(actions) do
    if a.name == name then count = count + 1 end
  end
  return count
end

local function feed(keys)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(keys, true, false, true), "x", false)
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
local pkg = vim.json.decode(table.concat(vim.fn.readfile(root .. "/package.json"), "\n"))
check(marks.version == pkg.version, "plugin version equals package.json version " .. pkg.version)
check(p0 and p0.plugin_version == marks.version, "payload carries the plugin version")

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

-- 8. ` previews fresh marks, then Neovim jumps directly on the mark key.
check(marks.config.map_backtick == true, "the backtick preview mapping is enabled by default")
check(vim.fn.maparg("`", "n") ~= "", "backtick is mapped in normal mode")
for _, mode in ipairs({ "i", "x", "o" }) do
  check(vim.fn.maparg("`", mode) == "", "backtick is not mapped in mode " .. mode)
end
vim.wait(50)
vim.api.nvim_buf_set_mark(0, "d", 1, 0, {})
marks.sync(true)
vim.api.nvim_buf_set_mark(0, "d", 3, 1, {})
n = #actions
local list_count = action_count("nvimMarks.list")
local original_lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("`d")
check(vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 3, 1 }), "`d jumps to the live mark's exact line and column without Enter")
check(#actions == n + 2 and actions[n + 1].name == "nvimMarks.preview"
  and actions[n + 2].name == "nvimMarks.hidePreview", "backtick opens a preview and closes it after the target key")
p = actions[n + 1].args[1]
local listed_entry = nil
for _, e in ipairs(p.locals) do
  if e.file == vim.fn.fnamemodify(file_b, ":p") then listed_entry = e end
end
local md = listed_entry and find(listed_entry.marks, "d")
check(md and md.line == 3 and md.col == 2, "the preview includes a mark moved since the last sync")
check(p.plugin_version == marks.version and find(p.globals, "B") ~= nil, "the preview carries the complete versioned snapshot")
feed("``")
check(vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 1, 0 }), "double backtick returns to the previous context")
feed("`<Esc>")
check(vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 1, 0 }), "Escape cancels a pending jump without moving the cursor")
check(actions[#actions].name == "nvimMarks.hidePreview", "Escape closes the preview")
feed("j")
check(vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 2, 0 }), "normal input resumes after cancelling a jump")
check(vim.deep_equal(vim.api.nvim_buf_get_lines(0, 0, -1, false), original_lines), "mark jumps and cancellation leave document text unchanged")
feed("`B")
check(vim.api.nvim_buf_get_name(0) == file_a and vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 5, 0 }),
  "uppercase marks jump directly across files")
check(action_count("nvimMarks.list") == list_count, "direct jumps and cancellation never open the search picker")
vim.cmd("edit " .. file_b)
n = #actions
check(marks.list() and #actions == n + 1 and actions[#actions].name == "nvimMarks.list", "explicit list() still opens the searchable picker")

-- 9. Neovim still owns operator motions and arguments to native commands.
local document_buf = vim.api.nvim_get_current_buf()
local native_buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_set_current_buf(native_buf)
list_count = action_count("nvimMarks.list")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "one two three" })
vim.api.nvim_buf_set_mark(0, "a", 1, 4, {})
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("d`a")
check(vim.api.nvim_get_current_line() == "two three", "d`a keeps its native operator-pending behavior")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "a`b" })
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("f`")
check(vim.api.nvim_win_get_cursor(0)[2] == 1, "f` still finds a literal backtick")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "abc" })
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("r`")
check(vim.api.nvim_get_current_line() == "`bc", "r` still replaces a character with a backtick")
vim.api.nvim_win_set_cursor(0, { 1, 1 })
feed("m`")
check(vim.fn.getpos("''")[3] == 2, "wrapped m` still sets the native previous-context mark")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "" })
feed("i`<Esc>")
check(vim.api.nvim_get_current_line() == "`", "insert mode types a literal backtick")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "abcde" })
vim.api.nvim_buf_set_mark(0, "a", 1, 3, {})
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("v`a<Esc>")
check(vim.api.nvim_win_get_cursor(0)[2] == 3, "visual-mode backtick jumps to the native mark")
check(action_count("nvimMarks.list") == list_count, "native backtick operations do not open the picker")

-- 10. Opting out after setup removes the preview wrapper and keeps native jumps.
marks.setup({ map_backtick = false, debounce_ms = 5 })
check(vim.fn.maparg("`", "n") == "", "map_backtick=false removes the plugin's previous mapping")
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("`a")
check(vim.api.nvim_win_get_cursor(0)[2] == 3, "native `a works after opting out")

-- 11. Opting out does not delete a user's replacement mapping.
marks.setup({ debounce_ms = 5 })
local user_calls = 0
local function user_mapping() user_calls = user_calls + 1 end
vim.keymap.set("n", "`", user_mapping)
marks.setup({ map_backtick = false, debounce_ms = 5 })
feed("`")
check(user_calls == 1, "opting out preserves a user's global replacement mapping")
vim.keymap.del("n", "`")

-- A buffer-local mapping can hide our global mapping, which must still be
-- removed while the buffer-local user mapping is retained.
marks.setup({ debounce_ms = 5 })
vim.keymap.set("n", "`", user_mapping, { buffer = native_buf })
marks.setup({ map_backtick = false, debounce_ms = 5 })
feed("`")
check(user_calls == 2, "opting out preserves a user's buffer-local mapping")
vim.api.nvim_set_current_buf(document_buf)
check(vim.fn.maparg("`", "n") == "", "opting out also removes a plugin mapping hidden by a buffer-local mapping")
vim.api.nvim_buf_delete(native_buf, { force = true })

-- 12. Teardown restores pre-existing mappings and cancels all pending work.
marks.teardown()
vim.keymap.set("n", "m", "m", { desc = "Original m", silent = true })
vim.keymap.set("n", "`", user_mapping, { desc = "Original backtick" })
local original_m = vim.fn.maparg("m", "n", false, true)
marks.setup({ debounce_ms = 5 })
marks.schedule_sync()
vim.api.nvim_exec_autocmds("CmdlineLeave", {})
n = #actions
local original_mark = vim.fn.getpos("'c")
marks.teardown()
marks.teardown()
vim.wait(50)
check(#actions == n, "teardown cancels initial sync, timers and queued CmdlineLeave work")
check(not marks.sync(true) and not marks.list(), "a stopped module cannot send actions")
check(vim.fn.exists("#NvimMarksSync") == 0, "teardown removes the autocmd group")
check(vim.fn.exists(":NvimMarksRefresh") == 0, "teardown removes its refresh command")
local restored_m = vim.fn.maparg("m", "n", false, true)
check(restored_m.rhs == original_m.rhs and restored_m.silent == original_m.silent and restored_m.desc == original_m.desc,
  "teardown restores the user's original string mapping and options")
feed("`")
check(user_calls == 3, "teardown restores the user's original Lua callback mapping")
check(vim.deep_equal(vim.fn.getpos("'c"), original_mark), "teardown leaves native marks intact")
vim.keymap.del("n", "m")
vim.keymap.del("n", "`")

-- 13. Reconfiguration has one initial sync and preserves user replacements.
n = #actions
marks.setup({ debounce_ms = 5 })
marks.setup({ debounce_ms = 5 })
vim.wait(50)
check(#actions == n + 1, "repeated setup sends one initial snapshot, with no stale callbacks")
vim.keymap.set("n", "m", user_mapping, { desc = "Replacement m" })
vim.keymap.set("n", "`", user_mapping, { desc = "Replacement backtick" })
vim.api.nvim_create_user_command("NvimMarksRefresh", function() user_calls = user_calls + 1 end, {})
marks.teardown()
check(vim.fn.maparg("m", "n", false, true).desc == "Replacement m", "teardown keeps a user's later m mapping")
check(vim.fn.maparg("`", "n", false, true).desc == "Replacement backtick", "teardown keeps a user's later backtick mapping")
vim.cmd("NvimMarksRefresh")
check(user_calls == 4, "teardown keeps a user's replacement command")
vim.api.nvim_del_user_command("NvimMarksRefresh")
vim.keymap.del("n", "m")
vim.keymap.del("n", "`")

-- 14. VS Code can wipe a document buffer when replacing a preview tab, then
-- recreate it from text rather than reading the file through Neovim.
marks.setup({ debounce_ms = 60000 })
local recreated_file = tmp .. "/recreated.txt"
local recreated_lines = { "first", "second", "third", "fourth" }
vim.fn.writefile(recreated_lines, recreated_file)
local function create_document(lines, before_list)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, recreated_file)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines or recreated_lines)
  vim.bo[buf].buftype = "acwrite"
  vim.bo[buf].modified = false
  if before_list then before_list(buf) end
  vim.bo[buf].buflisted = true
  return buf
end
local function close_document(buf)
  vim.api.nvim_set_current_buf(document_buf)
  vim.api.nvim_buf_delete(buf, { force = true })
end
local recreated = create_document()
vim.api.nvim_set_current_buf(recreated)
vim.api.nvim_win_set_cursor(0, { 3, 1 })
feed("ma")
close_document(recreated) -- before the debounced mark update
marks.setup({ debounce_ms = 5 }) -- settings changes must not discard recovery data
recreated = create_document()
check(vim.deep_equal(vim.api.nvim_buf_get_mark(recreated, "a"), { 3, 1 }),
  "recreated document restores a local mark before BufEnter, even without a previous sync")
vim.api.nvim_set_current_buf(recreated)
vim.api.nvim_win_set_cursor(0, { 1, 0 })
feed("`a")
check(vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 3, 1 }),
  "a recovered mark supports native jumps at its original line and byte column")

vim.api.nvim_set_current_buf(document_buf)
vim.api.nvim_buf_delete(recreated, { unload = true })
local unloaded_entry = nil
for _, e in ipairs(marks.collect().locals) do
  if e.file == recreated_file then unloaded_entry = e end
end
check(unloaded_entry and find(unloaded_entry.marks, "a") ~= nil,
  "unloaded buffers keep their native marks in the snapshot")
vim.api.nvim_set_current_buf(recreated)
check(vim.deep_equal(vim.api.nvim_buf_get_mark(recreated, "a"), { 3, 1 }),
  "reloading an unloaded buffer restores its native mark on all supported Neovim versions")
vim.cmd("delmarks a")
vim.api.nvim_set_current_buf(document_buf)
vim.api.nvim_set_current_buf(recreated)
check(vim.api.nvim_buf_get_mark(recreated, "a")[1] == 0,
  "switching back does not resurrect an explicitly deleted mark")
close_document(recreated)
recreated = create_document()
check(vim.api.nvim_buf_get_mark(recreated, "a")[1] == 0,
  "recreating a document does not resurrect an explicitly deleted mark")

vim.api.nvim_buf_set_mark(recreated, "a", 2, 1, {})
vim.api.nvim_buf_set_mark(recreated, "b", 4, 2, {})
close_document(recreated)
recreated = create_document({ "first", "second" }, function(buf)
  vim.api.nvim_buf_set_mark(buf, "a", 1, 0, {})
end)
check(vim.deep_equal(vim.api.nvim_buf_get_mark(recreated, "a"), { 1, 0 }),
  "recovery preserves a mark already set in the new buffer")
check(vim.api.nvim_buf_get_mark(recreated, "b")[1] == 0,
  "recovery skips marks beyond the end of a changed file")
check(vim.api.nvim_buf_get_mark(document_buf, "a")[1] == 0,
  "recovery never copies local marks into another file")
close_document(recreated)
marks.teardown()
marks.setup({ debounce_ms = 5 })
recreated = create_document()
check(vim.api.nvim_buf_get_mark(recreated, "a")[1] == 0,
  "teardown discards session recovery data")
marks.teardown()
close_document(recreated)

-- 15. Outside VS Code, setup is a no-op and does not require the vscode module.
package.loaded["nvim-marks"] = nil
package.loaded["vscode"] = nil
package.preload["vscode"] = nil
vim.g.vscode = nil
local ok = pcall(function() require("nvim-marks").setup({}) end)
check(ok, "setup() outside VS Code does not error")
check(vim.fn.maparg("`", "n") == "", "setup() outside VS Code does not install a backtick mapping")

vim.fn.delete(tmp, "rf")
io.stdout:write(string.format("\n%d failure(s)\n", failures))
os.exit(failures == 0 and 0 or 1)
