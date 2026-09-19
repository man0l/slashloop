-- Workspace retention defaults 3 -> 30 days (see src/lib/retention.ts).
-- SQLite cannot ALTER a column default in place, so this is the standard
-- table rebuild prisma generates for a @default change. Row data is copied
-- verbatim; existing workspaces were also updated by a one-off D1 UPDATE
-- (the sweeper reads the per-workspace value, not the default).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
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
    "thumbRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "mediaRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestEmail" TEXT,
    "lastDigestAt" DATETIME,
    "digestJson" TEXT
);
INSERT INTO "new_Workspace" ("analysisConfigJson", "autoAnalyzeRulesJson", "autoTopUp", "billingStatus", "createdAt", "digestEmail", "digestEnabled", "digestJson", "failureCountsJson", "id", "lastDigestAt", "mediaRetentionDays", "monthlyBudgetCents", "name", "ownerId", "packCredits", "periodEnd", "periodStart", "planCredits", "planKey", "stripeCustomerId", "stripeSubscriptionId", "stripeTestCustomerId", "stripeTestSubscriptionId", "thumbRetentionDays", "updatedAt") SELECT "analysisConfigJson", "autoAnalyzeRulesJson", "autoTopUp", "billingStatus", "createdAt", "digestEmail", "digestEnabled", "digestJson", "failureCountsJson", "id", "lastDigestAt", "mediaRetentionDays", "monthlyBudgetCents", "name", "ownerId", "packCredits", "periodEnd", "periodStart", "planCredits", "planKey", "stripeCustomerId", "stripeSubscriptionId", "stripeTestCustomerId", "stripeTestSubscriptionId", "thumbRetentionDays", "updatedAt" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");
CREATE UNIQUE INDEX "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Workspace_stripeTestCustomerId_key" ON "Workspace"("stripeTestCustomerId");
CREATE UNIQUE INDEX "Workspace_stripeTestSubscriptionId_key" ON "Workspace"("stripeTestSubscriptionId");
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

