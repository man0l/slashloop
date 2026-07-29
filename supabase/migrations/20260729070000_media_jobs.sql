-- MediaJob: work that cannot finish inside one request.
--
-- See docs/media-storage-plan.md §3.3. gemini-native has to download the MP4,
-- upload it to Gemini, wait for processing and then generate — which does not
-- fit api/mcp.ts's 60s ceiling, and that ceiling is not raisable on the current
-- Vercel plan. analyze_video records the intent here; a separate worker
-- invocation does the work on its own budget.
--
-- Purely additive: a new table and its indexes. No DROP, no column-type change,
-- no data rewrite. Every statement is IF NOT EXISTS so re-running is a no-op
-- rather than an error — the same hardening the billing migration uses, and it
-- matters here because we cannot verify the live database's exact state from
-- the environment this was written in.

CREATE TABLE IF NOT EXISTS "MediaJob" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "videoId"     TEXT NOT NULL,
  "kind"        TEXT NOT NULL DEFAULT 'analyze',
  "status"      TEXT NOT NULL DEFAULT 'queued',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "payloadJson" TEXT NOT NULL DEFAULT '{}',
  "opId"        TEXT,
  "analysisId"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"   TIMESTAMP(3),
  "finishedAt"  TIMESTAMP(3),

  CONSTRAINT "MediaJob_pkey" PRIMARY KEY ("id")
);

-- The worker's claim query orders queued rows oldest-first.
CREATE INDEX IF NOT EXISTS "MediaJob_status_createdAt_idx" ON "MediaJob" ("status", "createdAt");
-- get_video asks whether a job is outstanding for one video.
CREATE INDEX IF NOT EXISTS "MediaJob_videoId_status_idx"   ON "MediaJob" ("videoId", "status");
CREATE INDEX IF NOT EXISTS "MediaJob_workspaceId_idx"      ON "MediaJob" ("workspaceId");

-- ADD CONSTRAINT has no IF NOT EXISTS, so look it up in the catalog first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MediaJob_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MediaJob"
      ADD CONSTRAINT "MediaJob_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
