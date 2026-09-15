-- Revert Phase 4 native Google identity link (dropped; Supabase stays the
-- identity source of truth). 0003 added User.googleSub + its unique index;
-- no code reads it anymore, so remove both. The column holds only NULLs
-- after the data rollback (all linked rows were unlinked).
--
-- NOTE: applied manually via `wrangler d1 execute` during the revert
-- (2026-09-15) because the column was already dropped ad-hoc then; this file
-- only records the change for fresh databases. Both statements are
-- IF EXISTS-guarded... except ALTER TABLE has no IF EXISTS form in SQLite,
-- so re-running against a DB where the column is already gone fails with
-- "no such column". Fresh DBs (0003 applied, column present) apply cleanly.
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
DROP INDEX IF EXISTS "User_googleSub_key";
-- Already applied remotely; kept as documentation. Re-add the ALTER below
-- only when bootstrapping a fresh DB from 0001..0004 + this file:
-- ALTER TABLE "User" DROP COLUMN "googleSub";
SELECT 1;
