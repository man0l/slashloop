-- Post performance on the calendar (SLA-1199).
-- Counters are the platform's lifetime totals at metrics_synced_at; NULL = the
-- platform did not report that counter (or the post was never synced).
-- metrics_next_at drives the decaying sync cadence (src/social/metrics.ts):
-- every 10 min for the first 12h after publishing, hourly for the next 48h,
-- then daily. published_at anchors that cadence.
ALTER TABLE social_posts ADD COLUMN published_at INTEGER;
ALTER TABLE social_posts ADD COLUMN views INTEGER;
ALTER TABLE social_posts ADD COLUMN likes INTEGER;
ALTER TABLE social_posts ADD COLUMN comments INTEGER;
ALTER TABLE social_posts ADD COLUMN shares INTEGER;
ALTER TABLE social_posts ADD COLUMN metrics_synced_at INTEGER;
ALTER TABLE social_posts ADD COLUMN metrics_next_at INTEGER;
ALTER TABLE social_posts ADD COLUMN metrics_error TEXT;

-- Existing published rows: anchor on the last update (≈ publish time) and
-- make them due on the first tick.
UPDATE social_posts SET published_at = updated_at, metrics_next_at = 0 WHERE state = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS social_posts_metrics_due_idx ON social_posts (metrics_next_at) WHERE state = 'PUBLISHED';
