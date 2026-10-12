---
description: Refresh a tracked source to pull fresh scraped videos (uses proxy traffic and credits).
argument-hint: <source-id|name>
disable-model-invocation: true
allowed-tools: mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__get_scraper_spend_status, mcp__plugin_slashloop_slashloop__show_gallery
---
Refresh a source with the `refresh_source` MCP tool.

Resolve the source ID from $ARGUMENTS — accept a full ID, or if the user gives a
name/handle, call `list_sources` first to look it up. BEFORE refreshing, call
`get_scraper_spend_status` and report the remaining proxy traffic budget (TikTok refreshes
use metered proxy traffic; there is a hard monthly cap).

After a successful refresh:
1. Summarize how many new videos landed and remaining spend.
2. **Always** call `show_gallery` with `sourceId` set to the refreshed source so
   the user can see the scraped videos in the gallery UI (not only a text count).
3. Call out the top outliers by score in text.

If the refresh failed or returned zero videos, skip `show_gallery`.
