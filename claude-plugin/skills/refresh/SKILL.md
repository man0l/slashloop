---
description: Refresh a tracked source to pull fresh scraped videos (costs Apify credit).
argument-hint: <source-id|name>
disable-model-invocation: true
allowed-tools: mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__get_apify_spend_status
---
Refresh a source with the `refresh_source` MCP tool.

Resolve the source ID from $ARGUMENTS — accept a full ID, or if the user gives a
name/handle, call `list_sources` first to look it up. BEFORE refreshing, call
`get_apify_spend_status` and report remaining Apify budget (TikTok refreshes cost
real money; there is a hard monthly cap). After the refresh, summarize how many
new videos landed and call out any new outliers.
