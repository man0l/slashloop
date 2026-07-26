---
name: refresh
description: Refresh a tracked source to pull fresh videos via a live Apify TikTok scrape. Use after /track, or whenever a source has no data yet (lastRefreshedAt null). Costs against the monthly Apify cap.
argument-hint: "<sourceId>"
allowed-tools: mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__list_sources
---

Pull fresh videos for a tracked source with the `refresh_source` MCP tool.

If $ARGUMENTS has a source id, use it. If empty, call `list_sources` and show each
source with its id + `lastRefreshedAt`; refresh the stalest one (or ask which, if
several are similarly stale).

This is a **live Apify scrape** — it costs real money against the hard monthly
cap (default $5). Call `get_apify_spend_status` first; if headroom is low, warn
the user before proceeding. When it finishes, report how many videos landed and
surface the top outliers (`outlier_score`).

Only TikTok is live; Reels and Shorts scraping are stubs.
