-- Let MediaJob carry source-scoped work (refresh), not just video-scoped work.
--
-- Why: the refresh pipeline does not fit inside an MCP tool call. A scrape
-- consumes most of api/mcp.ts's 60s maxDuration and everything after it is
-- killed by the runtime. Observed in production: a refresh completed and billed
-- (10 items pulled, 9 new videos) while the cross-source rescore it was bought
-- FOR never ran, leaving the outlier on a stale `estimated` score. Moving the
-- pipeline onto the existing queue gives it a whole worker invocation, and
-- reclaimStuckJobs then covers the killed-mid-flight case that produced that
-- silent half-completion.
--
-- The queue was designed for this: MediaJob.kind already exists and
-- claimNextJob(kind) is already parameterised. Only the target column was
-- video-specific.
--
-- Safe to re-run: every statement is IF NOT EXISTS / conditional.

-- videoId becomes optional; a refresh job has no video.
ALTER TABLE "MediaJob" ALTER COLUMN "videoId" DROP NOT NULL;

ALTER TABLE "MediaJob" ADD COLUMN IF NOT EXISTS "sourceId" TEXT;
ALTER TABLE "MediaJob" ADD COLUMN IF NOT EXISTS "deadlineAt" TIMESTAMP(3);
ALTER TABLE "MediaJob" ADD COLUMN IF NOT EXISTS "preAuthCredits" INTEGER;

-- Exactly one target. Prisma cannot express this, and without it a malformed
-- enqueue would produce a job the worker silently cannot route.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MediaJob_one_target'
  ) THEN
    ALTER TABLE "MediaJob"
      ADD CONSTRAINT "MediaJob_one_target"
      CHECK (("videoId" IS NOT NULL)::int + ("sourceId" IS NOT NULL)::int = 1);
  END IF;
END $$;

-- The worker claims by (kind, status) ordered by age. The existing index is on
-- (status, createdAt), which no longer discriminates now that three kinds share
-- the table: a refresh worker would scan and skip every queued analyze row.
CREATE INDEX IF NOT EXISTS "MediaJob_kind_status_createdAt_idx"
  ON "MediaJob" ("kind", "status", "createdAt");

-- "is there a job for this source right now?", mirroring the videoId index.
CREATE INDEX IF NOT EXISTS "MediaJob_sourceId_status_idx"
  ON "MediaJob" ("sourceId", "status");

-- Backfill preAuthCredits for existing analyze rows so a reclaim of an
-- in-flight job refunds the right amount rather than falling through to a
-- default. 5 = CREDIT_COSTS.analyzeVideo at the time of this migration.
UPDATE "MediaJob"
   SET "preAuthCredits" = 5
 WHERE "preAuthCredits" IS NULL
   AND "kind" = 'analyze'
   AND "opId" IS NOT NULL;
