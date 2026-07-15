---
description: Run AI analysis on a video (shots, audio, on-screen text, hooks).
argument-hint: <video-id>
allowed-tools: mcp__plugin_slashloop_slashloop__analyze_video, mcp__plugin_slashloop_slashloop__get_video, mcp__plugin_slashloop_slashloop__get_video_transcript, mcp__plugin_slashloop_slashloop__get_feed
---
Analyze a video with the `analyze_video` MCP tool using the video ID from $ARGUMENTS.

If the ID is unclear, call `get_feed` (unanalyzed only) and pick the top outlier,
confirming with the user first. After analysis returns, summarize: the hook, the
strongest visual beats, and why it performed. Then offer next steps: `/slashloop:hooks`
to extract a reusable hook, or save it to a swipe board via `save_to_board`.
