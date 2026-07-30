---
description: Track a new creator, keyword, or hashtag across TikTok/Reels/Shorts.
argument-hint: <platform> <creator|keyword|hashtag> <query>
allowed-tools: mcp__plugin_slashloop_slashloop__create_source, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__show_gallery
---
Track a new source using the `create_source` MCP tool.

Parse $ARGUMENTS into:
- platform: tiktok | reels | shorts (default tiktok)
- sourceType: creator | keyword | hashtag
- query: the handle, keyword phrase, or hashtag (include the leading # for hashtags)

If anything is ambiguous, ask one short clarifying question.

When the user wants videos now (default): after `create_source`, call
`refresh_source` on the new id (warn once: live Apify cost), then **always**
call `show_gallery` with that `sourceId` so they can see the scrape in the UI.

If they only want to register without scraping, skip refresh/gallery and mention
`/slashloop:refresh <id>`. Reels and Shorts scraping are stubs — only TikTok is live.
