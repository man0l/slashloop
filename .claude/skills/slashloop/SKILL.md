---
description: Viral short-form video research toolkit (TikTok, Reels, YouTube Shorts). Use when the user wants to find outlier/viral videos, track a creator/keyword/hashtag, refresh scraped sources, run AI video analysis, or turn winners into hooks, ideas, and creative briefs. Trigger keywords: viral, outlier, tiktok, reels, shorts, track creator, track hashtag, hooks, swipe file, UGC brief, engagement rate.
user-invocable: false
---
# Slashloop — viral content research

A local MCP server provides ~32 tools. Prefer calling them directly rather than
asking the user to do manual steps.

## Core workflow

1. **Discover outliers** — `get_feed` (sort by outlier_score), or
   `get_outlier_summary` for a cross-source digest. To *show* videos visually,
   call `show_gallery` (MCP App UI).
2. **Track a source** — `create_source` (platform, sourceType, query), then
   `refresh_source` to pull fresh videos (TikTok is live via Apify; Reels/Shorts
   are stubs). **After a successful refresh, always call `show_gallery` with
   that `sourceId`** so the user sees the scraped videos, not only a count.
3. **Analyze a winner** — `analyze_video` (Gemini native video; auto-falls back
   to text-only). Pull transcript with `get_video_transcript`.
4. **Mine hooks** — `extract_hook` from an analysis, then
   `generate_hook_variations` to adapt. Browse with `list_hooks`.
5. **Produce creative** — `create_idea` -> `create_brief`. Save references to a
   board via `save_to_board`.

## Guardrails

- Live scraping costs money. Always check `get_apify_spend_status` before/after
  `refresh_source`. Hard monthly cap (`APIFY_SPEND_CAP_CENTS`, default $5);
  breached calls are refused.
- Batch analysis (`run_auto_analyze`) gets a 50% Gemini discount.
- If a tool returns nulls, the backend couldn't fill that field — say so, don't
  fabricate values.

## Shortcut skills

`/slashloop:track`, `/slashloop:discover`, `/slashloop:feed`, `/slashloop:refresh`,
`/slashloop:analyze`, `/slashloop:spend`, `/slashloop:outliers`, `/slashloop:hooks`.
