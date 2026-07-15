---
name: slashloop
description: Viral short-form video research toolkit (TikTok, Reels, YouTube Shorts). Use when the user wants to find outlier/viral videos, track a creator/keyword/hashtag, refresh scraped sources, run AI video analysis, or turn winners into hooks, ideas, and creative briefs. Trigger keywords: viral, outlier, tiktok, reels, shorts, track creator, track hashtag, hooks, swipe file, UGC brief, engagement rate.
---

# Slashloop — viral content research

A local MCP server named `slashloop` exposes ~32 tools. Prefer calling them
directly (they all start with `slashloop_`) rather than asking the user to do
manual steps.

## Core workflow

1. **Discover outliers** — `slashloop_get_feed` (sort by `outlier_score`),
   or `slashloop_get_outlier_summary` for a cross-source digest.
2. **Track a source** — `slashloop_create_source` (platform, sourceType,
   query). Then `slashloop_refresh_source` to pull fresh videos (TikTok is
   live via Apify; Reels/Shorts are stubs).
3. **Analyze a winner** — `slashloop_analyze_video` (Gemini native video
   understanding; auto-falls back to text-only). Pull transcript with
   `slashloop_get_video_transcript`.
4. **Mine hooks** — `slashloop_extract_hook` from an analysis, then
   `slashloop_generate_hook_variations` to adapt them. Browse with
   `slashloop_list_hooks`.
5. **Produce creative** — `slashloop_create_idea` → `slashloop_create_brief`.
   Save references to a board via `slashloop_save_to_board`.

## Guardrails

- Live scraping costs money. Always check `slashloop_get_apify_spend_status`
  before/after `refresh_source`. There is a hard monthly cap
  (`APIFY_SPEND_CAP_CENTS`, default $5); breached calls are refused.
- Batch analysis (`slashloop_run_auto_analyze`) gets a 50% Gemini discount.
- If a tool returns nulls, the backend couldn't fill that field — say so,
  don't fabricate values.

## Slash commands available

`/track`, `/discover`, `/feed`, `/refresh`, `/analyze`, `/spend`, `/outliers`,
`/hooks`. Each wraps the corresponding tool with friendlier argument parsing.
