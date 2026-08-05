-- Multi-workspace support: Workspace.ownerId is no longer unique
--
-- A user may now own several workspaces (agency use case, one per client),
-- each billed independently — see prisma/schema.prisma's Workspace model.
-- Workspace count per user is capped in application code by plan tier
-- (WORKSPACE_LIMITS in src/lib/workspaces.ts: free 1, creator 10, pro 50),
-- not by the database.
--
-- Drops the unique index Prisma created for the old `ownerId String? @unique`
-- and replaces it with a plain (non-unique) index of the same name Prisma's
-- own `@@index([ownerId])` would generate, so future `prisma db push` runs
-- see no further diff here. ownerId lookups (list a user's workspaces,
-- resolve their primary/earliest-created one) stay index-backed.
DROP INDEX IF EXISTS "Workspace_ownerId_key";

CREATE INDEX IF NOT EXISTS "Workspace_ownerId_idx"
  ON "Workspace"("ownerId");
