---
name: refresh
description: Refresh a tracked source to pull fresh videos via a live Apify TikTok scrape. Use after /track, or whenever a source has no data yet (lastRefreshedAt null). Costs against the monthly Apify cap.
argument-hint: "<sourceId>"
allowed-tools: mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__show_gallery
---

Pull fresh videos for a tracked source with the `refresh_source` MCP tool.

If $ARGUMENTS has a source id, use it. If empty, call `list_sources` and show each
source with its id + `lastRefreshedAt`; refresh the stalest one (or ask which, if
several are similarly stale).

This is a **live Apify scrape** — it costs real money against the hard monthly
cap (default $5). Call `get_apify_spend_status` first; if headroom is low, warn
the user before proceeding.

**After a successful refresh (any new videos, or a non-empty source):**

1. Report how many videos landed (and spend remaining).
2. **Always** call `show_gallery` with `sourceId` set to the source you just
   refreshed so the user can *see* the scraped videos in the interactive gallery
   (MCP App UI). Do not stop at a text count alone.
3. In text, briefly highlight the top outliers by `outlier_score`.

If the refresh failed or returned zero videos, skip `show_gallery` and say so.

Only TikTok is live; Reels and Shorts scraping are stubs.
