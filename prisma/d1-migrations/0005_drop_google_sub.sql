-- Revert Phase 4 native Google identity link (dropped; Supabase stays the
-- identity source of truth). 0003 added User.googleSub + its unique index;
-- no code reads it anymore, so remove both. The column holds only NULLs
-- after the data rollback (all linked rows were unlinked).
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
DROP INDEX IF EXISTS "User_googleSub_key";
ALTER TABLE "User" DROP COLUMN "googleSub";
