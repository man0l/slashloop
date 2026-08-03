-- Video.isBaselineSample: distinguishes real, source-discovered content from
-- videos pulled purely to keep a creator's outlier baseline fresh (see
-- src/scoring.ts rescoreStaleTooFresh and src/lib/refresh.ts runRefresh's
-- sourceTypeOverride/queryOverride).
--
-- Purely additive, idempotent — matches the convention set by earlier
-- migrations (this database has history from `prisma db push` runs, so
-- nothing may assume what has or hasn't already been applied). Existing rows
-- default to false (real content), which is correct: the baseline-sample
-- path did not exist before this.

ALTER TABLE "Video"
  ADD COLUMN IF NOT EXISTS "isBaselineSample" BOOLEAN NOT NULL DEFAULT false;
