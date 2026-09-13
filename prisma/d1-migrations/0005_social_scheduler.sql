-- Social post scheduler (docs/postiz-reuse-research.md in slashloop-site).
--
-- Two tables, deliberately OUTSIDE the Prisma schemas: the scheduler is a
-- Workers-only module (src/social/) that speaks raw SQL through rawBatch(),
-- and no VPS/Postgres runtime touches these tables. snake_case marks them as
-- not-Prisma-managed (every Prisma table here is quoted PascalCase).
--
-- social_integrations — one connected platform account (TikTok / YouTube /
--   Instagram) per user. Tokens are encrypted at rest? No: stored as received
--   from the platform, same trust level as the rest of the D1 shard.
-- social_posts — one row PER PLATFORM per scheduled submission. A user
--   submission that targets 3 channels creates 3 rows sharing one group_id
--   (Postiz's Post/Submission shape, minus multi-tenant cruft).
--
-- Engine contract (see src/social/engine.ts):
--   QUEUE → (cron tick, publish_date <= now) → PROCESSING
--   PROCESSING → pending flow: postPending → checkPostStatus → finalizePost
--              → PUBLISHED | attempts++ → back off | ERROR
-- All ticks are idempotent because every platform step is guarded by the
-- probe/check contract; pending_data carries the resumable-upload state
-- (TikTok publishId, YouTube uploadUri+uploadedBytes, IG containers[]).

CREATE TABLE IF NOT EXISTS social_integrations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- 'tiktok' | 'youtube' | 'instagram'
  internal_id TEXT NOT NULL,           -- platform-side user id (open_id, channel id, ig user id)
  profile TEXT,                        -- platform handle (without @)
  name TEXT,                           -- display name
  picture TEXT,
  token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at INTEGER,            -- epoch seconds
  refresh_needed INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS social_integrations_owner_provider_internal_idx
  ON social_integrations (owner_id, provider, internal_id);
CREATE INDEX IF NOT EXISTS social_integrations_refresh_idx
  ON social_integrations (token_expires_at);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- denormalized from the integration for cheap scans
  state TEXT NOT NULL DEFAULT 'QUEUE', -- QUEUE | PROCESSING | PUBLISHED | ERROR
  publish_date INTEGER NOT NULL,       -- epoch seconds, UTC
  content TEXT NOT NULL DEFAULT '',
  settings TEXT,                       -- JSON: provider-specific DTO (privacy, tags, …)
  media TEXT,                          -- JSON: [{type, url, alt, thumbnail}]
  pending_data TEXT,                   -- JSON: resumable-upload state (opaque per provider)
  release_id TEXT,
  release_url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER,               -- future: repeatable posts
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS social_posts_due_idx ON social_posts (state, publish_date);
CREATE INDEX IF NOT EXISTS social_posts_group_idx ON social_posts (group_id);
CREATE INDEX IF NOT EXISTS social_posts_owner_idx ON social_posts (owner_id);
CREATE INDEX IF NOT EXISTS social_posts_integration_idx ON social_posts (integration_id);
