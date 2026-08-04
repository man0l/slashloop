-- SuggestionDismissal: records a workspace's "no thanks" on an AI-suggested
-- hashtag/keyword/creator (src/lib/suggestions.ts), so a future
-- seedSourceCandidates() call excludes it — both from what's shown to the
-- user and from what gets sent to Gemini as "already tracked/considered" —
-- instead of re-proposing the same rejected candidate on every run.
--
-- Purely additive, idempotent — matches the convention set by earlier
-- migrations (this database has history from `prisma db push` runs, so
-- nothing may assume what has or hasn't already been applied).

CREATE TABLE IF NOT EXISTS "SuggestionDismissal" (
  "id"          TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "sourceType"  TEXT NOT NULL,
  "query"       TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "SuggestionDismissal_workspaceId_sourceType_query_key"
  ON "SuggestionDismissal" ("workspaceId", "sourceType", "query");

CREATE INDEX IF NOT EXISTS "SuggestionDismissal_workspaceId_idx"
  ON "SuggestionDismissal" ("workspaceId");

DO $$ BEGIN
  ALTER TABLE "SuggestionDismissal"
    ADD CONSTRAINT "SuggestionDismissal_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
