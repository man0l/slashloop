-- Drain the analyze queue from inside Postgres, once a minute.
--
-- Why this exists: the Vercel plan caps Vercel Cron at one run per day and
-- rejects sub-daily expressions at deploy time, so the queue's only reliable
-- drain was 24 hours away. pg_cron runs inside the database and is not subject
-- to that limit at all — it schedules per minute. That turns the worker
-- dispatch in src/lib/jobs.ts from the thing the system depends on into a
-- latency optimisation, which is what a best-effort call should be.
--
-- The job does two things every minute:
--   1. Reclaims abandoned `running` rows. This is pure SQL and mirrors
--      reclaimStuckJobs() in src/lib/jobs.ts — a worker killed mid-flight now
--      recovers within a minute instead of waiting for the daily sweep.
--   2. POSTs the worker endpoint, but ONLY when something is queued. An
--      unconditional per-minute POST would be 1440 idle function invocations a
--      day against a Hobby quota, to do nothing.
--
-- Secrets are read from Vault by name and are NOT in this file. Set them once
-- per environment (see README); until then the job is a harmless no-op, because
-- the http_post is gated on both secrets being present.
--
--   cron_secret      — must equal the CRON_SECRET env var the worker checks
--   worker_base_url  — e.g. https://mcp.slashloop.dev, no trailing slash
--
-- Safe to re-run: extensions are IF NOT EXISTS, and the schedule is unscheduled
-- before being recreated so the definition here always wins.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Recreate the schedule idempotently. cron.unschedule throws if the job is
-- absent, so ask first rather than swallowing every exception.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-analyze-jobs') THEN
    PERFORM cron.unschedule('drain-analyze-jobs');
  END IF;
END $$;

SELECT cron.schedule(
  'drain-analyze-jobs',
  '* * * * *',
  $job$
  -- 1. Recover jobs whose worker never reported back. Mirrors
  --    STUCK_AFTER_MINUTES / MAX_ATTEMPTS in src/lib/jobs.ts.
  UPDATE "MediaJob"
     SET "status"     = CASE WHEN "attempts" >= 3 THEN 'failed' ELSE 'queued' END,
         "startedAt"  = CASE WHEN "attempts" >= 3 THEN "startedAt" ELSE NULL END,
         "finishedAt" = CASE WHEN "attempts" >= 3 THEN now() ELSE NULL END,
         "lastError"  = 'Worker did not report back; recovered by pg_cron'
   WHERE "status" = 'running'
     AND "startedAt" < now() - INTERVAL '15 minutes';

  -- 2. Poke the worker only if there is work and both secrets are configured.
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_base_url')
           || '/api/jobs/analyze',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'),
      'Content-Type', 'application/json'
    )
  )
  WHERE EXISTS (SELECT 1 FROM "MediaJob" WHERE "status" = 'queued')
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_base_url');
  $job$
);
