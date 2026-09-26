-- Worker kill switches (Phase 4 write budget): a key/value control plane both
-- runtimes read, so a runaway loop is parked in seconds without a redeploy.
-- Missing row = enabled. Known keys: jobs.<kind>.enabled,
-- experiments.enabled, stale_rescrape.enabled ("0" disables).
--
-- Mirrors model WorkerControl in prisma/schema.prisma (and
-- prisma/schema.sqlite.prisma via sync-sqlite-schema.ts).
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
CREATE TABLE IF NOT EXISTS "WorkerControl" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL DEFAULT '',
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
