-- Drain the analyze queue from inside Postgres, once a minute.
--
-- Why this exists: the Vercel plan caps Vercel Cron at one run per day and
-- rejects sub-daily expressions at deploy time, so the queue's only reliable
-- drain was 24 hours away. pg_cron runs inside the database and is not subject
-- to that limit at all — it schedules per minute. That turns the worker
-- dispatch in src/lib/jobs.ts from the thing the system depends on into a
-- latency optimisation, which is what a best-effort call should be.
--
-- The job POSTs the worker endpoint and does nothing else. It deliberately does
-- NOT reclaim stuck rows itself: that policy (MAX_ATTEMPTS, STUCK_AFTER_MINUTES)
-- lives in src/lib/jobs.ts, and a second copy here in SQL would silently
-- diverge the first time someone tuned one and not the other. The worker
-- reclaims in TypeScript before it claims, so there is exactly one definition.
--
-- The POST is gated on a row existing in 'queued' OR 'running'. 'queued' is the
-- obvious case; 'running' is what lets an abandoned job get recovered at all,
-- since only the worker can decide it is abandoned. An idle queue therefore
-- costs zero function invocations rather than 1440 a day, and a genuinely
-- running job costs at most an extra poke or two that claims nothing and
-- returns immediately.
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
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_base_url')
           || '/api/jobs/analyze',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'),
      'Content-Type', 'application/json'
    )
  )
  WHERE EXISTS (SELECT 1 FROM "MediaJob" WHERE "status" IN ('queued', 'running'))
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_base_url');
  $job$
);
