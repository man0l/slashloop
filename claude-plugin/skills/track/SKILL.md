---
name: track
description: Track a new creator, keyword, or hashtag on TikTok/Reels/Shorts and immediately pull its videos. Use when the user wants to start monitoring a source for viral or outlier videos.
argument-hint: "<platform> <creator|keyword|hashtag> <query>"
allowed-tools: mcp__plugin_slashloop_slashloop__create_source, mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__show_gallery, mcp__plugin_slashloop_slashloop__await_job, mcp__plugin_slashloop_slashloop__get_job_status
---

Start tracking a source with `create_source`, then **immediately refresh it** to
pull videos — do not hand the next step back to the user.

Parse $ARGUMENTS into:

- **platform**: tiktok | reels | shorts (default tiktok)
- **sourceType**: creator | keyword | hashtag
- **query**: the handle, keyword phrase, or hashtag (include the leading `#` for hashtags)

If anything is ambiguous, ask one short question. Otherwise:

1. Call `create_source` and note the new source id.
2. Warn once that the next step is a **live Apify scrape** (~cost, against the
   $5/month cap), then call `refresh_source` on the new id to pull videos.
3. Report the source id and how many videos landed.
4. **Always** call `show_gallery` with that `sourceId` so the user can see the
   scraped videos in the gallery UI (not just a text summary).

If the user clearly only wants to register the source without scraping now, skip
steps 2–4. If refresh returns zero videos, skip `show_gallery` and say so.
Only TikTok is live; Reels and Shorts are stubs.
