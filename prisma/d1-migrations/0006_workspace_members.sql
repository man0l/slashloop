-- Team access (src/lib/team.ts in this repo) — one WorkspaceMember row per
-- invited teammate per workspace. Access is matched on the invitee's login
-- email (the `email` claim of their Supabase JWT), so an invite is live the
-- moment the row exists; the teammate just keeps using their own Google
-- sign-in. No roles yet: a member is a full peer of the owner
-- (requireWorkspaceAccess in src/lib/authz.ts).

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_email_key" ON "WorkspaceMember"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "WorkspaceMember_email_idx" ON "WorkspaceMember"("email");
