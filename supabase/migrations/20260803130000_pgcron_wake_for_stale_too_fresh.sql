-- Widen the drain-analyze-jobs wake condition (20260729080000) to also fire
-- for stale 'too_fresh' videos, not just queued/running MediaJob rows.
--
-- Found by direct verification: rescoreStaleTooFresh (src/scoring.ts) has no
-- MediaJob of its own — it acts on Score rows directly — so the existing gate
-- left it permanently dormant whenever nothing else happened to have a job
-- queued. Confirmed live: MediaJob had zero queued/running rows while 3
-- videos sat stuck at 'too_fresh' well past their 48h window; cron.job_run_
-- details showed "0 rows" on every run, meaning the worker endpoint was
-- never even invoked. A manual trigger (bypassing the gate) resolved them
-- immediately, proving the worker-side code was correct — only the wake
-- condition was missing this case.
--
-- Score.scoreType has no index; adding one keeps this new EXISTS check (and
-- rescoreStaleTooFresh's own query) cheap as the table grows, rather than a
-- sequential scan running every minute forever.

CREATE INDEX IF NOT EXISTS "Score_scoreType_idx" ON "Score" ("scoreType");

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
  WHERE (
      EXISTS (SELECT 1 FROM "MediaJob" WHERE "status" IN ('queued', 'running'))
      OR EXISTS (
        SELECT 1 FROM "Video" v
        JOIN "Score" sc ON sc."videoId" = v.id
        WHERE sc."scoreType" = 'too_fresh' AND v."postedAt" <= now() - interval '48 hours'
      )
    )
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_base_url');
  $job$
);
