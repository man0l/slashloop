-- Burst hardening (2026-09-22): the multi-kind claim (claimNextJobs in
-- src/lib/jobs.ts — WHERE status + kind IN + createdAt-range) was the first
-- D1 query to time out in the incident window. The claim only had
-- [status, createdAt] to work with, so every poll round scanned every
-- non-done job across ALL kinds (plus a payloadJson NOT LIKE evaluated per
-- candidate row). The composite index turns each claim into a bounded
-- per-kind range scan, with the LIKE confined to the recreate-kind window.
--
-- Mirrors the @@index addition in prisma/schema.prisma (and
-- prisma/schema.sqlite.prisma, kept in sync by src/scripts/sync-sqlite-schema.ts).
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
CREATE INDEX IF NOT EXISTS "MediaJob_status_kind_createdAt_idx"
  ON "MediaJob"("status", "kind", "createdAt");
