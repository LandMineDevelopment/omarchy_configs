return {
  "hrsh7th/nvim-cmp",
  opts = function(_, opts)
    local cmp = require("cmp")

    opts.mapping = {
      -- Confirm with Tab
      ["<Tab>"] = cmp.mapping.confirm({ select = true }),

      -- Navigate backwards with Shift-Tab
      ["<S-Tab>"] = cmp.mapping.select_prev_item(),

      -- Disable Enter for completion confirm
      ["<CR>"] = cmp.config.disable,

      -- Keep other useful defaults
      ["<C-n>"] = cmp.mapping.select_next_item(),
      ["<C-p>"] = cmp.mapping.select_prev_item(),
      ["<C-b>"] = cmp.mapping.scroll_docs(-4),
      ["<C-f>"] = cmp.mapping.scroll_docs(4),
      ["<C-Space>"] = cmp.mapping.complete(),
      ["<C-e>"] = cmp.mapping.abort(),
    }
  end,
}
