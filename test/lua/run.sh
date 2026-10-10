#!/usr/bin/env bash
# Runs the headless Neovim test for the Lua side. Requires `nvim` (>= 0.9) on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec nvim --headless --clean -l test/lua/spec.lua
