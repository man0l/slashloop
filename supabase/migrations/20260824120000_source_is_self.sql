-- Source.isSelf — this creator is the workspace owner's own TikTok account.
-- Scoring already uses the creator's median, so the gallery can label those
-- cards "You" and filter to the owner's posts vs niche outliers.
ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "isSelf" BOOLEAN NOT NULL DEFAULT false;
