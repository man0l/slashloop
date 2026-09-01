-- Slashloop D1 schema, initial version.
--
-- Generated with:
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.sqlite.prisma --script
-- (prisma/schema.sqlite.prisma is derived from prisma/schema.prisma — see
-- src/scripts/sync-sqlite-schema.ts) plus the MediaJob_one_target CHECK below,
-- which Prisma cannot express (mirrors supabase/migrations/20260801140000 +
-- 20260819120000 in their final form; SQLite needs no ::int cast — booleans
-- are 0/1 integers).
--
-- Apply with: wrangler d1 migrations apply slashloop --remote

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 5000,
    "autoAnalyzeRulesJson" TEXT NOT NULL DEFAULT '{}',
    "analysisConfigJson" TEXT NOT NULL DEFAULT '{"backend":"gemini-native","fallback":"gemini-text","geminiModel":"gemini-3.5-flash","fallbackModel":"gemini-3.5-flash-lite"}',
    "failureCountsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "planKey" TEXT NOT NULL DEFAULT 'free',
    "planCredits" INTEGER NOT NULL DEFAULT 300,
    "packCredits" INTEGER NOT NULL DEFAULT 0,
    "billingStatus" TEXT NOT NULL DEFAULT 'active',
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "autoTopUp" BOOLEAN NOT NULL DEFAULT false,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeTestCustomerId" TEXT,
    "stripeTestSubscriptionId" TEXT,
    "thumbRetentionDays" INTEGER NOT NULL DEFAULT 3,
    "mediaRetentionDays" INTEGER NOT NULL DEFAULT 3,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestEmail" TEXT,
    "lastDigestAt" DATETIME,
    "digestJson" TEXT
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "tool" TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "refId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SuggestionDismissal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SuggestionDismissal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "videoLimit" INTEGER NOT NULL DEFAULT 50,
    "refreshSchedule" TEXT NOT NULL DEFAULT 'manual',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSelf" BOOLEAN NOT NULL DEFAULT false,
    "nicheTag" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" DATETIME,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Source_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT NOT NULL DEFAULT '',
    "creatorHandle" TEXT NOT NULL,
    "creatorFollowers" INTEGER,
    "caption" TEXT NOT NULL DEFAULT '',
    "postedAt" DATETIME NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER,
    "saves" INTEGER,
    "durationSec" INTEGER,
    "transcript" TEXT,
    "transcriptSource" TEXT NOT NULL DEFAULT 'none',
    "rawJson" TEXT NOT NULL DEFAULT '{}',
    "scrapedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isBaselineSample" BOOLEAN NOT NULL DEFAULT false,
    "thumbKey" TEXT,
    "thumbStatus" TEXT NOT NULL DEFAULT 'none',
    "thumbStoredAt" DATETIME,
    "mediaKey" TEXT,
    "mediaStatus" TEXT NOT NULL DEFAULT 'none',
    "mediaBytes" INTEGER,
    "mediaStoredAt" DATETIME,
    "geminiFileUri" TEXT,
    "geminiFileName" TEXT,
    "geminiFileExpiresAt" DATETIME,
    "soundId" TEXT,
    "soundTitle" TEXT,
    "soundAuthor" TEXT,
    CONSTRAINT "Video_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanonicalScrapeLock" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "lockedBy" TEXT NOT NULL,
    "lockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Baseline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorHandle" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "medianViews" REAL NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Score" (
    "videoId" TEXT NOT NULL PRIMARY KEY,
    "outlierScore" REAL NOT NULL,
    "scoreType" TEXT NOT NULL DEFAULT 'actual',
    "explanation" TEXT NOT NULL,
    "scoredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Score_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'v3',
    "analysisJson" TEXT NOT NULL,
    "analysisBasis" TEXT NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'gemini-native',
    "model" TEXT NOT NULL DEFAULT 'gemini-3.5-flash',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Analysis_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Hook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT,
    "videoId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "hookType" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'extracted',
    "nicheTag" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Hook_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Hook_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Board" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Board_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SwipeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "boardId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "analysisSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "savedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SwipeEntry_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SwipeEntry_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "analysisId" TEXT,
    "transferablePattern" TEXT NOT NULL,
    "whyItWorked" TEXT NOT NULL,
    "adaptation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "dueAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Idea_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Idea_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "scriptJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Script_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Brief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ideaId" TEXT,
    "analysisId" TEXT NOT NULL,
    "briefJson" TEXT NOT NULL,
    "exportedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Brief_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Brief_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "refId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HookTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "sameInJson" TEXT NOT NULL DEFAULT '[]',
    "lever" TEXT NOT NULL DEFAULT 'hook',
    "beatsJson" TEXT NOT NULL DEFAULT '[]',
    "stopRule" TEXT,
    "status" TEXT NOT NULL DEFAULT 'setup',
    "winnerLabel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HookTest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HookTest_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HookVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "testId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "hookText" TEXT NOT NULL,
    "firstFrame" TEXT,
    "hookType" TEXT NOT NULL,
    "mechanism" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "assetUrl" TEXT,
    "ownPostId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HookVersion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "HookTest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "itemsPulled" INTEGER NOT NULL DEFAULT 0,
    "newVideos" INTEGER NOT NULL DEFAULT 0,
    "errorsJson" TEXT NOT NULL DEFAULT '[]',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoAnalyzeRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "analyzedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "batchMode" BOOLEAN NOT NULL DEFAULT true,
    "resultsJson" TEXT NOT NULL DEFAULT '[]',
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutoAnalyzeRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "videoId" TEXT,
    "sourceId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'analyze',
    "deadlineAt" DATETIME,
    "preAuthCredits" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "opId" TEXT,
    "analysisId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "MediaJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MediaJob_one_target" CHECK (
      (
        "kind" = 'discover'
        AND "videoId" IS NULL
        AND "sourceId" IS NULL
      )
      OR (
        "kind" <> 'discover'
        AND (("videoId" IS NOT NULL) + ("sourceId" IS NOT NULL) = 1)
      )
    )
);

-- CreateTable
CREATE TABLE "ScrapeAlertState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'scrape',
    "notifiedAt" DATETIME,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeTestCustomerId_key" ON "Workspace"("stripeTestCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeTestSubscriptionId_key" ON "Workspace"("stripeTestSubscriptionId");

-- CreateIndex
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");

-- CreateIndex
CREATE INDEX "CreditLedger_workspaceId_createdAt_idx" ON "CreditLedger"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_workspaceId_refId_key" ON "CreditLedger"("workspaceId", "refId");

-- CreateIndex
CREATE INDEX "SuggestionDismissal_workspaceId_idx" ON "SuggestionDismissal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SuggestionDismissal_workspaceId_sourceType_query_key" ON "SuggestionDismissal"("workspaceId", "sourceType", "query");

-- CreateIndex
CREATE INDEX "Source_workspaceId_idx" ON "Source"("workspaceId");

-- CreateIndex
CREATE INDEX "Source_platform_idx" ON "Source"("platform");

-- CreateIndex
CREATE INDEX "Source_isActive_idx" ON "Source"("isActive");

-- CreateIndex
CREATE INDEX "Video_sourceId_idx" ON "Video"("sourceId");

-- CreateIndex
CREATE INDEX "Video_platform_idx" ON "Video"("platform");

-- CreateIndex
CREATE INDEX "Video_creatorHandle_idx" ON "Video"("creatorHandle");

-- CreateIndex
CREATE INDEX "Video_postedAt_idx" ON "Video"("postedAt");

-- CreateIndex
CREATE INDEX "Video_views_idx" ON "Video"("views");

-- CreateIndex
CREATE INDEX "Video_thumbStatus_thumbStoredAt_idx" ON "Video"("thumbStatus", "thumbStoredAt");

-- CreateIndex
CREATE INDEX "Video_mediaStatus_mediaStoredAt_idx" ON "Video"("mediaStatus", "mediaStoredAt");

-- CreateIndex
CREATE INDEX "Video_soundId_idx" ON "Video"("soundId");

-- CreateIndex
CREATE UNIQUE INDEX "Video_sourceId_platform_externalId_key" ON "Video"("sourceId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "CanonicalScrapeLock_expiresAt_idx" ON "CanonicalScrapeLock"("expiresAt");

-- CreateIndex
CREATE INDEX "Baseline_creatorHandle_idx" ON "Baseline"("creatorHandle");

-- CreateIndex
CREATE UNIQUE INDEX "Baseline_creatorHandle_platform_key" ON "Baseline"("creatorHandle", "platform");

-- CreateIndex
CREATE INDEX "Score_outlierScore_idx" ON "Score"("outlierScore");

-- CreateIndex
CREATE INDEX "Score_scoreType_idx" ON "Score"("scoreType");

-- CreateIndex
CREATE INDEX "Analysis_videoId_idx" ON "Analysis"("videoId");

-- CreateIndex
CREATE INDEX "Hook_hookType_idx" ON "Hook"("hookType");

-- CreateIndex
CREATE INDEX "Hook_nicheTag_idx" ON "Hook"("nicheTag");

-- CreateIndex
CREATE INDEX "Hook_origin_idx" ON "Hook"("origin");

-- CreateIndex
CREATE INDEX "Board_workspaceId_idx" ON "Board"("workspaceId");

-- CreateIndex
CREATE INDEX "SwipeEntry_boardId_idx" ON "SwipeEntry"("boardId");

-- CreateIndex
CREATE UNIQUE INDEX "SwipeEntry_boardId_videoId_key" ON "SwipeEntry"("boardId", "videoId");

-- CreateIndex
CREATE INDEX "Idea_status_idx" ON "Idea"("status");

-- CreateIndex
CREATE INDEX "Script_analysisId_idx" ON "Script"("analysisId");

-- CreateIndex
CREATE INDEX "Script_format_idx" ON "Script"("format");

-- CreateIndex
CREATE INDEX "UsageLog_workspaceId_idx" ON "UsageLog"("workspaceId");

-- CreateIndex
CREATE INDEX "UsageLog_kind_idx" ON "UsageLog"("kind");

-- CreateIndex
CREATE INDEX "UsageLog_createdAt_idx" ON "UsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "HookTest_workspaceId_status_idx" ON "HookTest"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "HookTest_videoId_idx" ON "HookTest"("videoId");

-- CreateIndex
CREATE INDEX "HookVersion_testId_idx" ON "HookVersion"("testId");

-- CreateIndex
CREATE UNIQUE INDEX "HookVersion_testId_round_label_key" ON "HookVersion"("testId", "round", "label");

-- CreateIndex
CREATE INDEX "RefreshRun_sourceId_idx" ON "RefreshRun"("sourceId");

-- CreateIndex
CREATE INDEX "RefreshRun_ranAt_idx" ON "RefreshRun"("ranAt");

-- CreateIndex
CREATE INDEX "AutoAnalyzeRun_workspaceId_idx" ON "AutoAnalyzeRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AutoAnalyzeRun_ranAt_idx" ON "AutoAnalyzeRun"("ranAt");

-- CreateIndex
CREATE INDEX "MediaJob_status_createdAt_idx" ON "MediaJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaJob_videoId_status_idx" ON "MediaJob"("videoId", "status");

-- CreateIndex
CREATE INDEX "MediaJob_workspaceId_idx" ON "MediaJob"("workspaceId");

