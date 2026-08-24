-- Studio: logged posts (weekly retro), sound columns on Video, competitor flag.

ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "isCompetitor" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "soundId" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "soundTitle" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "soundAuthor" TEXT;

CREATE INDEX IF NOT EXISTS "Video_soundId_idx" ON "Video" ("soundId");

CREATE TABLE IF NOT EXISTS "LoggedPost" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "externalId" TEXT,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "hookVariation" TEXT NOT NULL DEFAULT '',
  "notes" TEXT NOT NULL DEFAULT '',
  "ideaId" TEXT,
  "videoId" TEXT,
  "outlierVideoId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoggedPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LoggedPost_workspaceId_url_key" ON "LoggedPost" ("workspaceId", "url");
CREATE INDEX IF NOT EXISTS "LoggedPost_workspaceId_postedAt_idx" ON "LoggedPost" ("workspaceId", "postedAt");

ALTER TABLE "LoggedPost" DROP CONSTRAINT IF EXISTS "LoggedPost_workspaceId_fkey";
ALTER TABLE "LoggedPost" ADD CONSTRAINT "LoggedPost_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LoggedPost" DROP CONSTRAINT IF EXISTS "LoggedPost_videoId_fkey";
ALTER TABLE "LoggedPost" ADD CONSTRAINT "LoggedPost_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LoggedPost" DROP CONSTRAINT IF EXISTS "LoggedPost_outlierVideoId_fkey";
ALTER TABLE "LoggedPost" ADD CONSTRAINT "LoggedPost_outlierVideoId_fkey"
  FOREIGN KEY ("outlierVideoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
