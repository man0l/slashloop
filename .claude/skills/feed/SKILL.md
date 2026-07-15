---
description: Show the ranked feed of outlier videos from tracked sources.
argument-hint: [limit] [platform|niche|min-views]
allowed-tools: mcp__plugin_slashloop_slashloop__get_feed, mcp__plugin_slashloop_slashloop__get_outlier_summary
---
Call the `get_feed` MCP tool to show the highest-performing videos.

Defaults: sort by outlier_score, limit 20. If the user gives a number, use it
as limit. Interpret optional filters from $ARGUMENTS: a platform name, a
nicheTag, a minimum-views threshold, or "analyzed only" / "unanalyzed only".
Present results grouped by source with views, engagement rate, and outlier
score, and highlight the single biggest outlier.
