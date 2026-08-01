---
name: discover
description: Search already-pulled videos by keyword, creator, or hashtag to find outlier/viral hits. Use to find videos that are already in the database.
argument-hint: "<query> [platform]"
allowed-tools: mcp__plugin_slashloop_slashloop__search_library, mcp__plugin_slashloop_slashloop__create_source, mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__await_job, mcp__plugin_slashloop_slashloop__get_job_status
---

Search pulled videos with the `search_library` MCP tool. Pass the user's query
($ARGUMENTS) + platform if stated (tiktok | reels | shorts; default tiktok).

This only filters videos **already in the DB** — it does not hit the live
network. If results are empty or thin, **do not just tell the user to run more
commands** — offer to do it inline: call `create_source` for the query, then
`refresh_source` to pull videos (warn once: live Apify scrape, ~cost), then
re-run `search_library`. Get the go-ahead once before spending.

Summarize the top hits with views and `outlier_score`.
