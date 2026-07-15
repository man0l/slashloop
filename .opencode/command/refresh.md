---
description: Refresh a tracked source to pull fresh scraped videos.
agent: build
---
Refresh a source with `slashloop_refresh_source`.

Resolve the source ID from $ARGUMENTS — accept a full ID, or if the user gives a name/handle,
call `slashloop_list_sources` first to look it up. Before refreshing, call
`slashloop_get_apify_spend_status` and report remaining Apify budget (TikTok refreshes cost
real money; there is a hard monthly cap). After the refresh, summarize how many new videos
landed and call out any new outliers.
