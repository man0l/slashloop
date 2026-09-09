-- D1 single-threaded index coverage (stalls /api/workspaces without these).
-- Unindexed filters push avg query from ~20ms toward 100ms+ (budget 10 qps -> 2 qps).
-- Mirrors @@index additions in prisma/schema.prisma:
--   Video  [sourceId, isBaselineSample, postedAt] (posts.ts, benchmark.ts + orderBy postedAt)
--   Source [workspaceId, isSelf, sourceType]      (isSelf lookups + sourceType filter)
--   MediaJob [sourceId, status, kind]             (outstandingJobForSource + sources-service lookups)
--   Hook [videoId], Idea [videoId]                (cascade deletes in sources-service deleteSourceForWorkspace)
CREATE INDEX IF NOT EXISTS "Video_sourceId_isBaselineSample_postedAt_idx" ON "Video"("sourceId", "isBaselineSample", "postedAt");
CREATE INDEX IF NOT EXISTS "Source_workspaceId_isSelf_sourceType_idx" ON "Source"("workspaceId", "isSelf", "sourceType");
CREATE INDEX IF NOT EXISTS "MediaJob_sourceId_status_kind_idx" ON "MediaJob"("sourceId", "status", "kind");
CREATE INDEX IF NOT EXISTS "Hook_videoId_idx" ON "Hook"("videoId");
CREATE INDEX IF NOT EXISTS "Idea_videoId_idx" ON "Idea"("videoId");
