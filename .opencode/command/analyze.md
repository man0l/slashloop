---
description: Run AI analysis on a video (shots, audio, on-screen text, hooks).
agent: build
---
Analyze a video with `slashloop_analyze_video` using the video ID from $ARGUMENTS.

If the ID is unclear, run `slashloop_get_feed` (unanalyzed only) and pick the top outlier,
confirming with the user first. After analysis returns, summarize: the hook, the strongest
visual beats, and why it performed. Then offer next steps: `/hooks` to extract a reusable
hook, or save to a swipe board via `slashloop_save_to_board`.
