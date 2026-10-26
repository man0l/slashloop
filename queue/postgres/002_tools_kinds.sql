-- 002_tools_kinds.sql — public-tools lookup kinds (SLA-1056).
--
-- Widens queue_jobs_kind_ck with the three slashloop.dev/tools kinds. Safe to
-- re-run: the constraint is dropped IF EXISTS and recreated, and every existing
-- row already satisfies the wider list. Apply AFTER 001 (a restore rehearsal
-- re-runs 001 then 002, in order):
--
--   psql -v ON_ERROR_STOP=1 -d slashloop_queue -f queue/postgres/002_tools_kinds.sql
--
-- Rollback: re-add the original seven-kind list from 001 (only valid while no
-- tools-* rows remain in queue_jobs).
BEGIN;

ALTER TABLE queue_jobs DROP CONSTRAINT IF EXISTS queue_jobs_kind_ck;
ALTER TABLE queue_jobs ADD CONSTRAINT queue_jobs_kind_ck CHECK (kind IN
  ('fetch','analyze','recreate','thumb','discover','rescore','refresh',
   'tools-profile-lite','tools-profile','tools-video'));

COMMIT;
