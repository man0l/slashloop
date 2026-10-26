-- 003_tools_trends_kind.sql — daily TikTok trends snapshot kind (SLA-1075).
--
-- Widens queue_jobs_kind_ck with 'tools-trends'. Same idempotent pattern as
-- 002: the constraint is dropped IF EXISTS and recreated, and every existing
-- row already satisfies the wider list. Apply AFTER 002 (a restore rehearsal
-- re-runs 001, 002, 003 in order):
--
--   psql -v ON_ERROR_STOP=1 -d slashloop_queue -f queue/postgres/003_tools_trends_kind.sql
--
-- Rollback: re-apply 002_tools_kinds.sql (only valid while no tools-trends
-- rows remain in queue_jobs).
BEGIN;

ALTER TABLE queue_jobs DROP CONSTRAINT IF EXISTS queue_jobs_kind_ck;
ALTER TABLE queue_jobs ADD CONSTRAINT queue_jobs_kind_ck CHECK (kind IN
  ('fetch','analyze','recreate','thumb','discover','rescore','refresh',
   'tools-profile-lite','tools-profile','tools-video','tools-trends'));

COMMIT;
