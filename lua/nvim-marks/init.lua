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
M.version = "0.1.12"

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
-- VS Code may close a preview document and recreate its Neovim buffer later.
-- Keep marks from unloaded/wiped document buffers until that file is reopened.
local retired_marks = {}
local attached_bufs = {}
local is_win = vim.fn.has("win32") == 1

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
  -- Reject non-file URI schemes (2+ scheme chars before ':', e.g. untitled:,
  -- vscode://, term://, output:, git:), including scheme-prefixed names that
  -- Neovim resolved relative to cwd, while keeping Windows drive paths.
  if file:match("^[a-zA-Z][a-zA-Z0-9+.-]+:") or file:match("[/\\][a-zA-Z][a-zA-Z0-9+.-]+:") then
    return nil
  end
  return vim.fn.fnamemodify(file, ":p")
end

local function file_key(file)
  if not file or file == "" then
    return nil
  end
  local s = file:gsub("\\", "/")
  s = s:gsub("([^/:])/+$", "%1")
  if is_win then
    s = s:lower()
  end
  return s
end

local function document_file(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return nil end
  local buftype = vim.bo[buf].buftype
  if buftype ~= "" and buftype ~= "acwrite" then return nil end
  return abs(vim.api.nvim_buf_get_name(buf))
end

local function local_marks(buf)
  local marks = {}
  for _, m in ipairs(vim.fn.getmarklist(buf)) do
    local name = m.mark:sub(2)
    if name:match("^[a-z]$") and m.pos[2] > 0 then
      marks[#marks + 1] = { name = name, line = m.pos[2], col = m.pos[3] }
    end
  end
  return marks
end

local function global_marks_for_buf(buf, key)
  local marks = {}
  for _, m in ipairs(vim.fn.getmarklist()) do
    local name = m.mark:sub(2)
    if name:match("^[A-Z]$") and m.pos[2] > 0 then
      local match = m.pos[1] == buf
      if not match and m.pos[1] == 0 then
        local mfile = abs(m.file)
        match = mfile ~= nil and file_key(mfile) == key
      end
      if match then
        marks[#marks + 1] = { name = name, line = m.pos[2], col = m.pos[3] }
      end
    end
  end
  return marks
end

local function remove_retired_global(name)
  for k, saved in pairs(retired_marks) do
    if saved.globals then
      for i = #saved.globals, 1, -1 do
        if saved.globals[i].name == name then
          table.remove(saved.globals, i)
        end
      end
      if #(saved.locals or {}) == 0 and #saved.globals == 0 then
        retired_marks[k] = nil
      end
    end
  end
end

local function restore_marks(buf)
  if not vim.api.nvim_buf_is_valid(buf) or not vim.api.nvim_buf_is_loaded(buf) then
    return
  end
  local buftype = vim.bo[buf].buftype
  if buftype ~= "" and buftype ~= "acwrite" and buftype ~= "nofile" then
    return
  end
  if buftype == "acwrite" and not vim.bo[buf].buflisted then
    return
  end
  local file = abs(vim.api.nvim_buf_get_name(buf))
  local key = file_key(file)
  local saved = key and retired_marks[key]
  if not saved then return end
  local line_count = vim.api.nvim_buf_line_count(buf)
  if line_count == 1 and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == "" then
    local needs_later_lines = false
    for _, mark in ipairs(saved.locals or {}) do
      if mark.line > 1 or mark.col > 1 then needs_later_lines = true break end
    end
    if not needs_later_lines then
      for _, mark in ipairs(saved.globals or {}) do
        if mark.line > 1 or mark.col > 1 then needs_later_lines = true break end
      end
    end
    if needs_later_lines then
      if not attached_bufs[buf] then
        attached_bufs[buf] = true
        local epoch = generation
        vim.api.nvim_buf_attach(buf, false, {
          on_lines = function(_, b)
            if not active or generation ~= epoch then
              attached_bufs[b] = nil
              return true
            end
            restore_marks(b)
            M.schedule_sync()
            if not retired_marks[key] then
              attached_bufs[b] = nil
              return true
            end
          end,
          on_detach = function(_, b)
            attached_bufs[b] = nil
          end,
        })
      end
      return
    end
  end
  -- Consume once: revisiting this buffer must never undo a later :delmarks.
  retired_marks[key] = nil
  for _, mark in ipairs(saved.locals or {}) do
    if mark.line > 0 and mark.line <= line_count and vim.api.nvim_buf_get_mark(buf, mark.name)[1] == 0 then
      pcall(vim.api.nvim_buf_set_mark, buf, mark.name, mark.line, mark.col - 1, {})
    end
  end
  for _, mark in ipairs(saved.globals or {}) do
    if mark.line > 0 and mark.line <= line_count then
      local pos = vim.fn.getpos("'" .. mark.name)
      local deleted = pos[1] == 0 and pos[2] == 0
      local in_other_valid_buf = pos[1] ~= 0 and pos[1] ~= buf and pos[1] ~= saved.buf and vim.api.nvim_buf_is_valid(pos[1])
      local already_set_in_new_buf = buf ~= saved.buf and vim.api.nvim_buf_get_mark(buf, mark.name)[1] > 0
      if not deleted and not in_other_valid_buf and not already_set_in_new_buf then
        pcall(vim.api.nvim_buf_set_mark, buf, mark.name, mark.line, mark.col - 1, {})
      end
    end
  end
end

--- Build the snapshot of all marks worth drawing.
--- @return table payload  { version = 1, plugin_version = "x.y.z", locals = {...}, globals = {...} }
function M.collect()
  local locals = {}
  local seen_local_keys = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    -- vscode-neovim sets buftype=acwrite on every document buffer.
    -- Newer Neovim versions clear local marks on unload, so use the snapshot
    -- captured before unloading until the native marks can be restored.
    local file = document_file(buf)
    local key = file_key(file)
    if file and key then
      seen_local_keys[key] = true
      local marks
      if vim.api.nvim_buf_is_loaded(buf) then
        restore_marks(buf)
        marks = local_marks(buf)
      else
        local saved = retired_marks[key]
        marks = (saved and saved.locals) or local_marks(buf)
      end
      if #marks > 0 then
        locals[#locals + 1] = { file = file, marks = marks }
      end
    end
  end
  for key, saved in pairs(retired_marks) do
    if not seen_local_keys[key] and saved.locals and #saved.locals > 0 then
      locals[#locals + 1] = { file = saved.file, marks = saved.locals }
    end
  end

  local globals = {}
  local seen_global_names = {}
  for _, m in ipairs(vim.fn.getmarklist()) do
    local name = m.mark:sub(2)
    if name:match("^[A-Z]$") and m.pos[2] > 0 then
      local file = m.file
      local line = m.pos[2]
      local col = m.pos[3]
      local skip = false
      -- A global mark in a loaded buffer carries the buffer number; prefer
      -- the buffer's name, which is always absolute, and reject non-file buftypes.
      if m.pos[1] ~= 0 and vim.api.nvim_buf_is_valid(m.pos[1]) then
        local buftype = vim.bo[m.pos[1]].buftype
        if buftype ~= "" and buftype ~= "acwrite" then
          skip = true
        else
          local bufname = vim.api.nvim_buf_get_name(m.pos[1])
          if bufname ~= "" then
            file = bufname
          end
          if not vim.api.nvim_buf_is_loaded(m.pos[1]) then
            local resolved = abs(file)
            local k = file_key(resolved)
            local saved = k and retired_marks[k]
            if saved and saved.globals then
              local found = false
              for _, g in ipairs(saved.globals) do
                if g.name == name then
                  line = g.line
                  col = g.col
                  found = true
                  break
                end
              end
              if not found then
                saved.globals[#saved.globals + 1] = { name = name, line = line, col = col }
              end
            elseif resolved and k then
              retired_marks[k] = {
                file = resolved,
                buf = m.pos[1],
                locals = local_marks(m.pos[1]),
                globals = { { name = name, line = line, col = col } },
              }
            end
          end
        end
      end
      if vim.api.nvim_buf_is_valid(m.pos[1]) and vim.api.nvim_buf_is_loaded(m.pos[1]) then
        remove_retired_global(name)
      end
      seen_global_names[name] = true
      file = not skip and abs(file) or nil
      if file then
        globals[#globals + 1] = { name = name, file = file, line = line, col = col }
      end
    end
  end
  for _, saved in pairs(retired_marks) do
    for _, g in ipairs(saved.globals or {}) do
      if not seen_global_names[g.name] and vim.fn.getpos("'" .. g.name)[2] > 0 then
        seen_global_names[g.name] = true
        globals[#globals + 1] = { name = g.name, file = saved.file, line = g.line, col = g.col }
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
  local payload = M.collect()
  last_sent = vim.json.encode(payload)
  vs.action("nvimMarks.list", { args = { payload } })
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
  local payload
  if vs then
    payload = M.collect()
    last_sent = vim.json.encode(payload)
    vs.action("nvimMarks.preview", { args = { payload } })
  end
  local ok, ch = pcall(vim.fn.getcharstr)
  if vs then vs.action("nvimMarks.hidePreview") end
  if not ok or ch == "" or ch == "\27" then return "" end
  if vs and ch:match("^[A-Z]$") and payload then
    local target = nil
    for _, g in ipairs(payload.globals) do
      if g.name == ch then
        target = g
        break
      end
    end
    if target then
      local cur_buf = vim.api.nvim_get_current_buf()
      local cur_key = file_key(document_file(cur_buf))
      if cur_key and file_key(target.file) == cur_key then
        if vim.fn.getpos("'" .. ch)[1] ~= cur_buf then
          local line_count = vim.api.nvim_buf_line_count(cur_buf)
          if line_count > 0 then
            pcall(vim.api.nvim_buf_set_mark, cur_buf, ch, math.min(target.line, line_count), target.col - 1, {})
          end
        end
      else
        -- Open cross-file global marks through VS Code so vscode-neovim attaches a
        -- real file:// document instead of an unmanaged external buffer.
        vs.action("nvimMarks.jump", { args = { target } })
        return "m'"
      end
    end
  end
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
  retired_marks = {}
  attached_bufs = {}
end

function M.setup(opts)
  local saved_marks = retired_marks
  M.teardown()
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  if type(M.config.debounce_ms) ~= "number"
    or M.config.debounce_ms < 0
    or M.config.debounce_ms ~= math.floor(M.config.debounce_ms)
  then
    M.config.debounce_ms = defaults.debounce_ms
  end

  if not vim.g.vscode then
    -- Outside VS Code the sign column already shows marks via other plugins;
    -- do nothing rather than fail when `require("vscode")` is missing.
    return
  end

  active = true
  retired_marks = saved_marks
  local epoch = generation
  group = vim.api.nvim_create_augroup("NvimMarksSync", { clear = true })
  local events = {
    -- vscode-neovim lists a document buffer after setting its name and text,
    -- but suppresses BufEnter/BufWinEnter while creating its window.
    "BufAdd",
    "BufReadPost",
    "BufEnter",
    "BufWinEnter",
    "BufWritePost",
    "CursorHold",
    "InsertLeave",
    "TextChanged",
  }
  if type(M.config.extra_events) == "table" then
    for _, ev in ipairs(M.config.extra_events) do
      if type(ev) == "string" and vim.fn.exists("##" .. ev) == 1 then
        events[#events + 1] = ev
      end
    end
  end
  vim.api.nvim_create_autocmd(events, {
    group = group,
    callback = function(event)
      restore_marks(event.buf)
      M.schedule_sync()
    end,
  })

  vim.api.nvim_create_autocmd({ "BufUnload", "BufWipeout" }, {
    group = group,
    callback = function(event)
      local file = document_file(event.buf)
      local key = file_key(file)
      if file and key and (event.event == "BufUnload" or not retired_marks[key]) then
        -- Read live marks before destruction, even if the last m/:delmarks
        -- happened too recently for the debounced snapshot to reach VS Code.
        local locals = local_marks(event.buf)
        local globals = global_marks_for_buf(event.buf, key)
        for _, g in ipairs(globals) do
          remove_retired_global(g.name)
        end
        if #locals > 0 or #globals > 0 then
          retired_marks[key] = { file = file, buf = event.buf, locals = locals, globals = globals }
        else
          retired_marks[key] = nil
        end
      end
      -- BufWipeout may follow BufUnload after Neovim has cleared the marks.
      -- Retain the earlier snapshot rather than replace it with an empty one.
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
