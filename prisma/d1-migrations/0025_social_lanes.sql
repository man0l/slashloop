-- Social lanes + weekly rotation (SLA-1177).
-- tags: JSON string[] on a connected account ("lane:<name>", "primary"); NULL = [].
ALTER TABLE social_integrations ADD COLUMN tags TEXT;

CREATE TABLE IF NOT EXISTS social_rotations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lanes TEXT NOT NULL,            -- JSON string[], ordered
  anchor_monday TEXT NOT NULL,    -- 'YYYY-MM-DD', must be a Monday in `timezone`
  period_days INTEGER NOT NULL DEFAULT 7,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS social_rotations_owner_name_idx ON social_rotations (owner_id, name);
