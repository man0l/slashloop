-- Stuck-claim sweep index: reclaimStuckJobs filters
-- WHERE status = 'running' AND startedAt < cutoff. Without this the sweep is a
-- full MediaJob scan over the D1 HTTP API (observed: timeouts on all workers).
-- Mirrors @@index([status, startedAt]) added to prisma/schema.prisma.
CREATE INDEX IF NOT EXISTS "MediaJob_status_startedAt_idx" ON "MediaJob"("status", "startedAt");
