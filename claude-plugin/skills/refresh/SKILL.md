---
name: refresh
description: Refresh a tracked source to pull fresh videos via a live Apify TikTok scrape. Use after /track, or whenever a source has no data yet (lastRefreshedAt null). Costs against the monthly Apify cap.
argument-hint: "<sourceId>"
allowed-tools: mcp__plugin_slashloop_slashloop__refresh_source, mcp__plugin_slashloop_slashloop__await_job, mcp__plugin_slashloop_slashloop__get_job_status, mcp__plugin_slashloop_slashloop__rescore_sources, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__show_gallery
---

Pull fresh videos for a tracked source with the `refresh_source` MCP tool.

If $ARGUMENTS has a source id, use it. If empty, call `list_sources` and show each
source with its id + `lastRefreshedAt`; refresh the stalest one (or ask which, if
several are similarly stale).

This is a **live Apify scrape** — it costs real money against the hard monthly
cap (default $5). Call `get_apify_spend_status` first; if headroom is low, warn
the user before proceeding.

## Refreshes above 10 videos are queued, not immediate

A scrape does not fit inside one tool call. Anything over ~10 videos is enqueued
and `refresh_source` returns a `jobId` instead of counts — the work happens in a
worker with its own time budget.

When you get a `jobId`:

1. Call `await_job` with it. That blocks server-side for ~25s and returns as
   soon as the job is `done` or `failed`.
2. Call it again **only while `shouldKeepPolling` is true**. Stop the moment it
   is false — that flag already accounts for the job's deadline, so do not
   second-guess it or keep your own timer. Never exceed 12 calls for one job.
3. If it stops on the deadline rather than a result, say so plainly: the job may
   still be running, and `get_job_status` checks later without waiting.

Tell the user it is running rather than going silent for a minute. Credits are
charged by the worker when it runs, not at enqueue, so a queued job that never
runs has cost nothing.

If a refresh finished but scores elsewhere look stale — a creator's videos in a
hashtag source still reading `estimated` — call `rescore_sources` with that
`creatorHandle`. It is free and needs no scrape.

**After a successful refresh (any new videos, or a non-empty source):**

1. Report how many videos landed (and spend remaining).
2. **Always** call `show_gallery` with `sourceId` set to the source you just
   refreshed so the user can *see* the scraped videos. Do not stop at a text
   count alone. If the interactive gallery does not appear in the conversation,
   give the user the `galleryUrl` from the result as a clickable link — it opens
   the same gallery in their browser.
3. In text, briefly highlight the top outliers, **leading with `scoreType:
   "actual"`** ones. An `estimated` score compares a video to its source's
   median and mostly reflects account size; an `actual` score compares a
   creator to themselves and is the real signal.
4. Then offer the next step from the result's `nextSteps` — usually analyzing
   the creator-relative outliers. State the credit cost and wait for a yes
   before spending. Do not end the turn at "here are your videos".

If the refresh failed or returned zero videos, skip `show_gallery` and say so.

Only TikTok is live; Reels and Shorts scraping are stubs.
