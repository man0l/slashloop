-- Single-owner transport marker (SLA-10 rev 4 Phase 2, SLA-16).
--
-- queueOwner: 'd1' (legacy D1 queue — the default, so every existing row stays
-- D1-owned and the migration is backward-compatible), 'pg' (D1 compatibility
-- projection of a PG-owned job — legacy D1 workers must ignore it),
-- 'fallback_d1' (PG publish failed; the reconciler republishes with
-- dedupeKey d1:<MediaJob.id> and the original opId; non-claimable).
--
-- Legacy D1 claims add queueOwner = 'd1' (see src/lib/jobs.ts), so PG and
-- fallback rows are never selected by D1 workers. No backfill: the column
-- default covers all pre-migration rows. The covering index keeps the
-- filtered claim a bounded range scan (same pattern as 0011).
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
ALTER TABLE "MediaJob" ADD COLUMN "queueOwner" TEXT NOT NULL DEFAULT 'd1';
CREATE INDEX IF NOT EXISTS "MediaJob_status_kind_queueOwner_createdAt_idx"
  ON "MediaJob" ("status", "kind", "queueOwner", "createdAt");
