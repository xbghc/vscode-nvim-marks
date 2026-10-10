--- nvim-marks: push Neovim marks to the "Neovim Marks" VS Code extension.
---
--- Marks stay entirely native to Neovim (`ma`, `'a`, `` `a ``, `d'a`, `:marks`,
--- `:delmarks` all work unchanged). This module only snapshots them and sends
--- the snapshot to VS Code, which draws them in the gutter.
---
--- Usage (lazy.nvim):
---   { "xbghc/vscode-nvim-marks", cond = vim.g.vscode ~= nil, opts = {} }

local M = {}

local defaults = {
  --- Wrap `m` in normal mode so a newly set mark shows up immediately
  --- instead of after the next CursorHold.
  map_m = true,
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
--- @return table payload  { version = 1, locals = {...}, globals = {...} }
function M.collect()
  local locals = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == "" then
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

  return { version = 1, locals = locals, globals = globals }
end

--- Send the snapshot now (no debounce). Skips the RPC if nothing changed.
--- @param force boolean|nil  send even if unchanged
--- @return boolean sent
function M.sync(force)
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

--- Debounced sync; several triggers in quick succession yield one RPC.
function M.schedule_sync()
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
  timer = (vim.uv or vim.loop).new_timer()
  timer:start(M.config.debounce_ms, 0, function()
    timer:stop()
    timer:close()
    timer = nil
    vim.schedule(function()
      M.sync(false)
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

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})

  if not vim.g.vscode then
    -- Outside VS Code the sign column already shows marks via other plugins;
    -- do nothing rather than fail when `require("vscode")` is missing.
    return
  end

  local group = vim.api.nvim_create_augroup("NvimMarksSync", { clear = true })
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
      vim.schedule(M.schedule_sync)
    end,
  })

  if M.config.map_m then
    vim.keymap.set("n", "m", set_mark_interactive, { desc = "Set mark (synced to VS Code)" })
  end

  vim.api.nvim_create_user_command("NvimMarksRefresh", function()
    M.refresh()
  end, { desc = "Resend all marks to VS Code" })

  -- Initial push once the UI is up.
  vim.schedule(function()
    M.sync(true)
  end)
end

return M
