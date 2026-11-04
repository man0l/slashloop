-- Instagram insights availability per account (SLA-1265).
-- Re-touched so deploy-worker's migration diff picks it up: the deploy of #306 failed before
-- the migrate step and the next deploy diffed against it, so 0029 was never applied.
-- 'ok' | reason code (missing_permission, personal_account, no_data, error: ...) | NULL = not synced yet.
ALTER TABLE social_integrations ADD COLUMN insights_status TEXT;
