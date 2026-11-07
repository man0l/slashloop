-- YouTube Analytics retention (SLA-1403). NULL = not reported (non-YouTube
-- posts, or the channel was connected before the yt-analytics.readonly scope):
--   engaged_views   — Studio "engaged views" (viewers who did not swipe away)
--   avg_view_pct    — averageViewPercentage, 0-100
--   avg_view_secs   — averageViewDuration in seconds
--   stayed_to_watch — engaged_views / views, 0-1 (Studio "stayed to watch")
--   retention_curve — JSON array of audienceWatchRatio, evenly spaced by elapsedVideoTimeRatio
ALTER TABLE social_posts ADD COLUMN engaged_views INTEGER;
ALTER TABLE social_posts ADD COLUMN avg_view_pct REAL;
ALTER TABLE social_posts ADD COLUMN avg_view_secs REAL;
ALTER TABLE social_posts ADD COLUMN stayed_to_watch REAL;
ALTER TABLE social_posts ADD COLUMN retention_curve TEXT;
