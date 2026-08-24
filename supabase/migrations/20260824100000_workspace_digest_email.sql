-- Workspace.digestEmail — per-workspace digest recipient override.
-- Null = send to the owner's auth.users email (previous behavior). The
-- weekly cron groups all of an owner's due workspaces into ONE email, so
-- this only changes the destination, not the fan-out.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "digestEmail" TEXT;
