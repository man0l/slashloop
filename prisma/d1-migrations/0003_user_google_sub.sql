-- Phase 4 native Google identity link (see src/cf/account-link.ts).
--
-- Migrated Supabase rows keep their Supabase-sub User.id; the first Google
-- login attaches User.googleSub (`google:<sub>`) and moves that user's
-- Workspace.ownerId values to the same `google:<sub>` in one atomic batch.
-- Users created natively post-cutover use `google:<sub>` as both id and
-- googleSub. Nullable + unique: rows start unlinked (NULL), and SQLite (like
-- Postgres) allows multiple NULLs in a UNIQUE index, so the backfill is a
-- no-op for existing rows. Mirrors `googleSub String? @unique` on User in
-- prisma/schema.prisma.
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleSub_key" ON "User"("googleSub");
