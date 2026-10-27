-- Workspace.publicToken (SLA-1093): opt-in, revocable read-only link to a workspace's
-- outlier gallery (/s/<token>). NULL = not shared. Mirrors prisma/schema*.prisma.
ALTER TABLE "Workspace" ADD COLUMN "publicToken" TEXT;
CREATE UNIQUE INDEX "Workspace_publicToken_key" ON "Workspace"("publicToken");
