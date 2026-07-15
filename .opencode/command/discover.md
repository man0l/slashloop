---
description: Search already-scraped videos across sources by keyword/creator/hashtag.
agent: build
---
Search the local video database with `slashloop_discover_search`.

Pass the user's query ($ARGUMENTS) and pick the platform if stated (tiktok | reels | shorts;
default tiktok). IMPORTANT: this only filters videos already in the DB — it does not hit the
live network. If results are thin, suggest `/track` + `/refresh` to pull fresh videos first,
then search again. Summarize top hits with views and outlier score.
