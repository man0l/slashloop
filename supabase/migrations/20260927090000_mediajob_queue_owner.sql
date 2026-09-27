-- Single-owner transport marker (SLA-10 rev 4 Phase 2, SLA-16).
-- Mirrors prisma/schema.prisma MediaJob.queueOwner + the D1 migration
-- prisma/d1-migrations/0014_mediajob_queue_owner.sql.
--
-- queueOwner: 'd1' (default, legacy D1 queue), 'pg' (D1 compatibility
-- projection of a PG-owned job), 'fallback_d1' (PG publish failed, awaiting
-- one-way reconciliation with dedupeKey d1:<MediaJob.id>).
ALTER TABLE "MediaJob" ADD COLUMN IF NOT EXISTS "queueOwner" TEXT NOT NULL DEFAULT 'd1';
CREATE INDEX IF NOT EXISTS "MediaJob_status_kind_queueOwner_createdAt_idx"
  ON "MediaJob"("status", "kind", "queueOwner", "createdAt");
