---
name: discover
description: Discover trackable TikTok sources (hashtags, creators, keywords) from a few niche keywords or hashtags. Live — probes real TikTok data before suggesting anything.
argument-hint: "<keywords, #hashtags and/or @handles>"
allowed-tools: mcp__plugin_slashloop_slashloop__discover, mcp__plugin_slashloop_slashloop__create_source, mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__await_job, mcp__plugin_slashloop_slashloop__get_job_status, mcp__plugin_slashloop_slashloop__search_library
---

Run the `discover` MCP tool with the user's niche ($ARGUMENTS) split into a
keywords array — plain terms, #hashtags and @handles all work.

**Warn once before spending**: the AI seed expansion costs 3 credits and each
seed probe is ~1.5 credits per video sampled (≤ ~45 credits worst case, empty
probes refunded). Get an explicit go-ahead first.

Relay the results plainly: which seeds came back live (with sample counts),
which died (`deadSeeds`), then the verified suggestions — mined hashtags
("seen in N of M sampled videos, avg X views"), creators (median views,
followers), and the probed seeds themselves. Every suggestion was checked
against real TikTok data — say so, it's the point.

Ask which ones to track. For each pick: `create_source` (free), then
`refresh_source` (costs ~1.5 credits/video — confirm separately before the
first refresh). Nothing is tracked automatically.
