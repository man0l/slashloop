---
description: Track a new creator, keyword, or hashtag across TikTok/Reels/Shorts.
agent: build
---
Track a new source using the `slashloop_create_source` tool.

Parse the user's input ($ARGUMENTS) into:
- **platform**: tiktok | reels | shorts (default: tiktok)
- **sourceType**: creator | keyword | hashtag
- **query**: the handle, keyword phrase, or hashtag (include the leading # for hashtags)

If the user is ambiguous about platform or type, ask one short clarifying question.
After creating, confirm the source ID and mention they can run `/refresh <sourceId>`
to pull videos. Note Reels/Shorts scraping are stubs; only TikTok is live.
