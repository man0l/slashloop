---
description: Browse the Hook Vault or extract a hook from an analyzed video.
argument-hint: [video-id|search]
allowed-tools: mcp__plugin_slashloop_slashloop__list_hooks, mcp__plugin_slashloop_slashloop__extract_hook, mcp__plugin_slashloop_slashloop__generate_hook_variations
---
If $ARGUMENTS contains a video/analysis ID, call `extract_hook` to pull a reusable
hook from that analysis into the Hook Vault. Otherwise call `list_hooks` to browse
existing hooks (filter by hook type, niche, or search text if the user specified).
Present a few strong hooks and offer `generate_hook_variations` to adapt one to the
user's product/niche.
