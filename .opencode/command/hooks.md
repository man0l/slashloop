---
description: Browse the Hook Vault or extract a hook from a analyzed video.
agent: build
---
If $ARGUMENTS contains a video/analysis ID, call `slashloop_extract_hook` to pull a reusable
hook from that analysis into the Hook Vault. Otherwise call `slashloop_list_hooks` to browse
existing hooks (filter by hook type, niche, or search text if the user specified). Present a
few strong hooks and offer `slashloop_generate_hook_variations` to adapt one to the user's
product/niche.
