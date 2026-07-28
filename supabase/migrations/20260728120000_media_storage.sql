-- Media storage: object keys on Video, retention settings on Workspace
--
-- Phase 1 of docs/media-storage-plan.md. Persists TikTok cover images and
-- MP4s in Supabase Storage; these columns are the DB half of that (the
-- buckets themselves are created in the Supabase dashboard, see the plan §1.2).
--
-- Purely additive — no DROP, no type change, no data rewrite. Every statement
-- is idempotent, matching the convention set by the billing migration: this
-- database has history from `prisma db push` runs, so nothing may assume what
-- has or hasn't already been applied.
--
-- Existing rows get the DEFAULTs: retention 3 days, no stored media.

-- ---------------------------------------------------------------------------
-- Workspace: media retention settings
--
-- User-writable through update_settings but validated server-side against the
-- plan ceiling (src/lib/retention.ts). Retention drives storage and egress, so
-- an uncapped user-writable field here would repeat the monthlyBudgetCents
-- mistake documented in docs/stripe-implementation-plan.md §0.2.
-- ---------------------------------------------------------------------------
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "thumbRetentionDays" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "mediaRetentionDays" INTEGER NOT NULL DEFAULT 3;

-- ---------------------------------------------------------------------------
-- Video: stored-object keys and status
--
-- thumbnailUrl is deliberately left alone. It stays as provenance and as the
-- only way to re-ingest a cover after the sweeper removes the stored copy.
-- ---------------------------------------------------------------------------
ALTER TABLE "Video"
  ADD COLUMN IF NOT EXISTS "thumbKey"      TEXT,
  ADD COLUMN IF NOT EXISTS "thumbStatus"   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "thumbStoredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mediaKey"      TEXT,
  ADD COLUMN IF NOT EXISTS "mediaStatus"   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "mediaBytes"    INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaStoredAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Indexes for the retention sweeper
--
-- It scans "rows of status X whose storedAt is older than this workspace's
-- window", ordered by storedAt. Without these it is a sequential scan of
-- Video on every daily run.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Video_thumbStatus_thumbStoredAt_idx"
  ON "Video" ("thumbStatus", "thumbStoredAt");

CREATE INDEX IF NOT EXISTS "Video_mediaStatus_mediaStoredAt_idx"
  ON "Video" ("mediaStatus", "mediaStoredAt");
