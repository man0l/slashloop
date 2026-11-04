-- Instagram insights availability per account (SLA-1265).
-- 'ok' | reason code (missing_permission, personal_account, no_data, error: ...) | NULL = not synced yet.
ALTER TABLE social_integrations ADD COLUMN insights_status TEXT;
