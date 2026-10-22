--- nvim-marks: push Neovim marks to the "Neovim Marks" VS Code extension.
---
--- Marks stay native to Neovim (`ma`, `'a`, `d'a`, `:marks`, `:delmarks`). This
--- module sends snapshots to VS Code for gutter decorations and a mark picker.
--- Normal-mode ` previews marks while the next key performs a native jump.
---
--- Bundled with the VS Code extension and loaded into its Neovim session.

local M = {}

--- Release of this plugin, sent with every payload so the VS Code extension
--- can tell when the two halves drift apart. test/lua/spec.lua keeps it equal
--- to the version in package.json.
M.version = "0.1.8"

local defaults = {
  --- Wrap `m` in normal mode so a newly set mark shows up immediately
  --- instead of after the next CursorHold.
  map_m = true,
  --- Preview marks while waiting for the target of a native ` jump.
  map_backtick = true,
  --- Debounce window for the push, in milliseconds.
  debounce_ms = 60,
  --- Extra events that trigger a sync, besides the built-in ones.
  extra_events = {},
  --- Name of the VS Code command that receives the payload.
  command = "nvimMarks.update",
}

M.config = vim.deepcopy(defaults)

local last_sent = nil
local timer = nil
local vscode_mod = nil
local active = false
local generation = 0
local group = nil
local command_definition = nil
local mappings = {}

local function global_mapping(lhs)
  for _, mapping in ipairs(vim.api.nvim_get_keymap("n")) do
    if mapping.lhs == lhs then return mapping end
  end
end

local function map(lhs, callback, desc, opts)
  mappings[lhs] = { previous = global_mapping(lhs), callback = callback }
  vim.keymap.set("n", lhs, callback, vim.tbl_extend("force", { desc = desc }, opts or {}))
end

local function vscode()
  if vscode_mod then
    return vscode_mod
  end
  local ok, mod = pcall(require, "vscode")
  if not ok then
    ok, mod = pcall(require, "vscode-neovim")
  end
  if ok then
    vscode_mod = mod
  end
  return vscode_mod
end

local function abs(file)
  if file == nil or file == "" then
    return nil
  end
  return vim.fn.fnamemodify(file, ":p")
end

--- Build the snapshot of all marks worth drawing.
--- @return table payload  { version = 1, plugin_version = "x.y.z", locals = {...}, globals = {...} }
function M.collect()
  local locals = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    -- vscode-neovim sets buftype=acwrite on every document buffer.
    local buftype = vim.bo[buf].buftype
    if vim.api.nvim_buf_is_loaded(buf) and (buftype == "" or buftype == "acwrite") then
      local file = abs(vim.api.nvim_buf_get_name(buf))
      if file then
        local marks = {}
        for _, m in ipairs(vim.fn.getmarklist(buf)) do
          local name = m.mark:sub(2)
          if name:match("^[a-z]$") then
            marks[#marks + 1] = { name = name, line = m.pos[2], col = m.pos[3] }
          end
        end
        if #marks > 0 then
          locals[#locals + 1] = { file = file, marks = marks }
        end
      end
    end
  end

  local globals = {}
  for _, m in ipairs(vim.fn.getmarklist()) do
    local name = m.mark:sub(2)
    if name:match("^[A-Z]$") then
      local file = m.file
      -- A global mark in a loaded buffer carries the buffer number; prefer
      -- the buffer's name, which is always absolute.
      if m.pos[1] ~= 0 and vim.api.nvim_buf_is_valid(m.pos[1]) then
        local bufname = vim.api.nvim_buf_get_name(m.pos[1])
        if bufname ~= "" then
          file = bufname
        end
      end
      file = abs(file)
      if file then
        globals[#globals + 1] = { name = name, file = file, line = m.pos[2], col = m.pos[3] }
      end
    end
  end

  return { version = 1, plugin_version = M.version, locals = locals, globals = globals }
end

--- Send the snapshot now (no debounce). Skips the RPC if nothing changed.
--- @param force boolean|nil  send even if unchanged
--- @return boolean sent
function M.sync(force)
  if not active then return false end
  local payload = M.collect()
  local encoded = vim.json.encode(payload)
  if not force and encoded == last_sent then
    return false
  end
  local vs = vscode()
  if not vs then
    return false
  end
  last_sent = encoded
  vs.action(M.config.command, { args = { payload } })
  return true
end

--- Open the mark picker with a fresh snapshot, without waiting for a sync.
--- The payload travels in the same RPC as the action so VS Code cannot open
--- the picker before receiving the latest marks.
--- @return boolean sent
function M.list()
  if not active then return false end
  local vs = vscode()
  if not vs then
    return false
  end
  vs.action("nvimMarks.list", { args = { M.collect() } })
  return true
end

--- Debounced sync; several triggers in quick succession yield one RPC.
function M.schedule_sync()
  if not active then return end
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
  local epoch = generation
  local pending = (vim.uv or vim.loop).new_timer()
  timer = pending
  pending:start(M.config.debounce_ms, 0, function()
    pending:stop()
    pending:close()
    if timer == pending then timer = nil end
    vim.schedule(function()
      if active and generation == epoch then M.sync(false) end
    end)
  end)
end

--- Force a resend regardless of the change check. Useful after VS Code
--- reloads its window and loses the extension's state.
function M.refresh()
  return M.sync(true)
end

local function set_mark_interactive()
  local ok, ch = pcall(vim.fn.getcharstr)
  if not ok or ch == "" or ch == "\27" then
    return
  end
  pcall(vim.cmd, "normal! m" .. ch)
  M.schedule_sync()
end

local function jump_mark_interactive()
  local vs = vscode()
  if vs then vs.action("nvimMarks.preview", { args = { M.collect() } }) end
  local ok, ch = pcall(vim.fn.getcharstr)
  if vs then vs.action("nvimMarks.hidePreview") end
  if not ok or ch == "" or ch == "\27" then return "" end
  -- Return an unmapped native jump, preserving special marks and the jumplist.
  return "`" .. ch
end

--- Remove only our session resources. Never write to the user's config.
function M.teardown()
  active = false
  generation = generation + 1
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
  if group then
    pcall(vim.api.nvim_del_augroup_by_id, group)
    group = nil
  end
  for lhs, saved in pairs(mappings) do
    local current = global_mapping(lhs)
    if current and current.callback == saved.callback then
      vim.keymap.del("n", lhs)
      if saved.previous then vim.fn.mapset("n", false, saved.previous) end
    end
  end
  mappings = {}
  local command = vim.api.nvim_get_commands({}).NvimMarksRefresh
  if command_definition and command and command.definition == command_definition then
    vim.api.nvim_del_user_command("NvimMarksRefresh")
  end
  command_definition = nil
  last_sent = nil
  vscode_mod = nil
end

function M.setup(opts)
  M.teardown()
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})

  if not vim.g.vscode then
    -- Outside VS Code the sign column already shows marks via other plugins;
    -- do nothing rather than fail when `require("vscode")` is missing.
    return
  end

  active = true
  local epoch = generation
  group = vim.api.nvim_create_augroup("NvimMarksSync", { clear = true })
  local events = {
    "BufEnter",
    "BufWinEnter",
    "BufWritePost",
    "CursorHold",
    "InsertLeave",
    "TextChanged",
  }
  vim.list_extend(events, M.config.extra_events)
  vim.api.nvim_create_autocmd(events, {
    group = group,
    callback = function()
      M.schedule_sync()
    end,
  })

  -- `:delmarks`, `:mark x`, `:k x` run after CmdlineLeave fires, so defer.
  vim.api.nvim_create_autocmd("CmdlineLeave", {
    group = group,
    callback = function()
      vim.schedule(function()
        if active and generation == epoch then M.schedule_sync() end
      end)
    end,
  })

  if M.config.map_m then
    map("m", set_mark_interactive, "Set mark (synced to VS Code)")
  end

  if M.config.map_backtick then
    -- Keep operator-pending and character arguments such as d`a, f` and r`
    -- native by installing this in Neovim's normal-mode mapping table only.
    map("`", jump_mark_interactive, "Jump to Neovim mark", { expr = true })
  end

  vim.api.nvim_create_user_command("NvimMarksRefresh", function()
    M.refresh()
  end, { desc = "Resend all marks to VS Code" })
  command_definition = vim.api.nvim_get_commands({}).NvimMarksRefresh.definition

  -- Initial push once the UI is up.
  vim.schedule(function()
    if active and generation == epoch then M.sync(true) end
  end)
end

return M
