---
description: Track a new creator, keyword, or hashtag across TikTok/Reels/Shorts.
argument-hint: <platform> <creator|keyword|hashtag> <query>
allowed-tools: mcp__plugin_slashloop_slashloop__create_source, mcp__plugin_slashloop_slashloop__list_sources
---
Track a new source using the `create_source` MCP tool.

Parse $ARGUMENTS into:
- platform: tiktok | reels | shorts (default tiktok)
- sourceType: creator | keyword | hashtag
- query: the handle, keyword phrase, or hashtag (include the leading # for hashtags)

If anything is ambiguous, ask one short clarifying question. After creating,
confirm the new source ID and mention `/slashloop:refresh <id>` to pull videos.
Note: Reels and Shorts scraping are stubs — only TikTok is live.
