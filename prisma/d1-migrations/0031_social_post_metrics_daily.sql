-- Per-post, per-UTC-day snapshot of the lifetime counters (SLA-1439), so the
-- account stats chart can show views *gained* per day. One row per post per
-- day: saveMetrics upserts today's row on every sync, and the 03:00 cron
-- carries a post's latest row forward to yesterday when no sync landed.
CREATE TABLE social_post_metrics_daily (
  post_id TEXT NOT NULL,
  day TEXT NOT NULL,              -- 'YYYY-MM-DD', UTC
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, reach INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, day)
);
CREATE INDEX social_post_metrics_daily_day_idx ON social_post_metrics_daily(day);

-- Baseline: the counters as of each post's last sync. Not a gain — the read
-- path counts a first row only when the post was published that same day.
INSERT INTO social_post_metrics_daily (post_id, day, views, likes, comments, shares, saves, reach, synced_at)
SELECT id, date(metrics_synced_at, 'unixepoch'), views, likes, comments, shares, saves, reach, metrics_synced_at
FROM social_posts
WHERE metrics_synced_at IS NOT NULL;
