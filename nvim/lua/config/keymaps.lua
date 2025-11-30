-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

--arrow key format for movement
vim.keymap.del("n", "j")
vim.keymap.del("n", "k")

vim.keymap.set("n", "j", "h", { noremap = true, silent = true })
vim.keymap.set("n", "h", "i", { noremap = true, silent = true })
vim.keymap.set("n", "i", "gk", { noremap = true, silent = true })
vim.keymap.set("n", "k", "gj", { noremap = true, silent = true })

vim.keymap.del("v", "j")
vim.keymap.del("v", "k")

vim.keymap.set("v", "j", "h", { noremap = true, silent = true })
vim.keymap.set("v", "h", "i", { noremap = true, silent = true })
vim.keymap.set("v", "i", "gk", { noremap = true, silent = true })
vim.keymap.set("v", "k", "gj", { noremap = true, silent = true })

-- Normal mode: make <Home> go to ^
vim.keymap.set("n", "<Home>", "^", { noremap = true, silent = true })

-- Insert mode: make <Home> go to first non-blank (leaves you in insert mode)
vim.keymap.set("i", "<Home>", "<C-o>^", { noremap = true, silent = true })
--
-- Visual mode: same as normal mode
vim.keymap.set("v", "<Home>", "^", { noremap = true, silent = true })

-- NORMAL MODE end settings
vim.keymap.set("n", "<End>", "g_", { noremap = true, silent = true })

-- INSERT MODE end settings
vim.keymap.set("i", "<End>", "<C-o>g_<C-o>a", { noremap = true, silent = true })

-- VISUAL MODE end settings
vim.keymap.set("v", "<End>", "g_", { noremap = true, silent = true })
--
-- moving between windows
vim.keymap.del("n", "<C-h>")
--
vim.keymap.set("n", "<C-j>", "<C-w>h", { desc = "Move to left window" })
vim.keymap.set("n", "<C-k>", "<C-w>j", { desc = "Move to left window" })
vim.keymap.set("n", "<C-i>", "<C-w>k", { desc = "Move to left window" })
-- vim.keymap.set("n", "<C-l>", "<C-w>l", { desc = "Move to left window" })

-- Remap Shift+H to act like Shift+J
vim.keymap.del("n", "<S-h>")
vim.keymap.set("n", "<S-j>", "<cmd>bprevious<CR>", { desc = "Prev Buffer" })

--- Make 'd' delete without yanking (redirect to black hole register)
-- Note: This affects normal mode (e.g., dd, dw) and visual mode (e.g., vd)
local function delete_to_black_hole()
  return [["_d]]
end

-- change "d" function
vim.keymap.set("n", "d", delete_to_black_hole, { expr = true, desc = "Delete without yanking" })
vim.keymap.set("v", "d", delete_to_black_hole, { expr = true, desc = "Delete without yanking" })

-- Make capital D behave exactly like lowercase d
vim.keymap.set("n", "D", "d", { noremap = true, desc = "Same as d" })
vim.keymap.set("v", "D", "d", { noremap = true, desc = "Same as d" })

-- Quit Neovim with Q
vim.keymap.set("n", "q", ":q<CR>", { desc = "Quit Neovim" })
vim.keymap.set("n", "<S-q>", ":wq<CR>", { desc = "Save Quit Neovim" })
