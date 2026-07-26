---
name: discover
description: Search already-scraped videos across tracked sources by keyword, creator, or hashtag. Use to find outlier or viral videos that are already in the local database.
argument-hint: "<query> [platform]"
allowed-tools: mcp__plugin_slashloop_slashloop__discover_search, mcp__plugin_slashloop_slashloop__list_sources
---

Search the local video database with the `discover_search` MCP tool.

Pass the user's query ($ARGUMENTS) and pick the platform if stated
(tiktok | reels | shorts; default tiktok). This only filters videos already in
the DB — it does not hit the live network. If results are thin, suggest
`/slashloop:track` + `/slashloop:refresh` to pull fresh videos first, then
search again. Summarize top hits with views and outlier score.
