CREATE TABLE "Experiment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "dataJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "createKey" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Experiment_workspaceId_createKey_key" ON "Experiment"("workspaceId", "createKey");
CREATE INDEX "Experiment_workspaceId_createdAt_idx" ON "Experiment"("workspaceId", "createdAt");
CREATE INDEX "Experiment_status_updatedAt_idx" ON "Experiment"("status", "updatedAt");
