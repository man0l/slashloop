-- Weekly digest (api/cron/digest.ts, get_digest tool).
--
-- Three nullable/defaulted columns on Workspace:
--   "digestEnabled" — opt-out flag, default true (digest is the retention engine).
--   "lastDigestAt"  — build/send watermark; also the cron's idempotency gate.
--   "digestJson"    — last payload, served by get_digest between runs.
--
-- Guarded so re-running is a no-op (see README "Schema changes").

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "digestEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "lastDigestAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "digestJson" TEXT;
