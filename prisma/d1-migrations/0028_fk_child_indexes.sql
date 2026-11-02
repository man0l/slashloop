-- Foreign-key child lookups (SLA-1225). D1 enforces the RESTRICT FKs, so
-- deleting a parent row (Analysis, Idea, Video) makes SQLite look the child
-- table up by the FK column; with no index that is a full scan per parent row
-- and "delete workspace" hung on a workspace with a few hundred videos.
CREATE INDEX IF NOT EXISTS "Hook_analysisId_idx" ON "Hook"("analysisId");
CREATE INDEX IF NOT EXISTS "Idea_analysisId_idx" ON "Idea"("analysisId");
CREATE INDEX IF NOT EXISTS "Brief_analysisId_idx" ON "Brief"("analysisId");
CREATE INDEX IF NOT EXISTS "Brief_ideaId_idx" ON "Brief"("ideaId");
CREATE INDEX IF NOT EXISTS "SwipeEntry_videoId_idx" ON "SwipeEntry"("videoId");
CREATE INDEX IF NOT EXISTS "ExperimentWebhookOutbox_workspaceId_idx" ON "ExperimentWebhookOutbox"("workspaceId");
