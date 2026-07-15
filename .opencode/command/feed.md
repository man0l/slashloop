---
description: Show the ranked feed of outlier videos from tracked sources.
agent: build
---
Call `slashloop_get_feed` to show the highest-performing videos.

Defaults: sort by `outlier_score`, limit 20. If the user gives a number, use it as `limit`.
Interpret optional filters from $ARGUMENTS: a platform name, a `nicheTag`, a min views
threshold, or "analyzed only"/"unanalyzed only". Present results grouped by source with
views, engagement rate, and outlier score, and highlight the single biggest outlier.
