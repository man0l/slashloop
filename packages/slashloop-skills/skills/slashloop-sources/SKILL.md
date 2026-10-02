---
name: slashloop-sources
description: Create or list Slashloop tracked sources (creator, keyword, hashtag, or collection) in an explicit workspace. Use for source management, not scraping.
---

# Slashloop sources

Inputs:

- `workspace`: workspace ID or exact workspace name. **Required.** If absent,
  stop and ask for it.
- `operation`: `create` or `list`. If absent, infer it; ambiguity stops the skill.

Resolve `workspace` with `list_workspaces`. Match an exact ID or a
case-insensitive exact name. Do not default to the primary workspace. Stop on no
match or multiple name matches, then pass the resolved ID as `workspaceId` to
every later call.

## Create

Required: `platform`, `sourceType`, and `query`.

- `platform` must be `tiktok`; Reels and Shorts are refused by the service.
- `sourceType` is `creator`, `keyword`, `hashtag`, or `collection`.
- `query` is `@handle`, a phrase, `#hashtag`, or a collection share URL/ID.
  Keep the leading `#`; keep or add `@` for creators.

Optional defaults: `language="en"`, `videoLimit=20`, `refreshSchedule="manual"`,
`nicheTag`, and `isSelf=true` (creator only). `videoLimit` prices the first
refresh at about 1.5 credits/video, not creation. Call `create_source` once and
return its `sourceId`. Do not refresh or call the gallery from this skill.

## List

Call `list_sources`. Apply only the requested `platform`, `sourceType`,
`isActive`, or `nicheTag` filters. Return source ID, query, type, platform,
active state, and `lastRefreshedAt`; do not scrape.
