-- Move off gemini-2.5-flash-lite, which Google has retired.
--
-- The API now answers every call with:
--   404 "This model models/gemini-2.5-flash-lite is no longer available to new
--        users. Please update your code to use a newer model."
--
-- Observed 2026-07-29. This is why no analysis had succeeded since 2026-07-18:
-- both backends read the same geminiModel, so the primary and its fallback were
-- failing for the identical reason, and the workspace default pinned the dead
-- model on every new workspace.
--
-- Two changes, both additive in effect:
--   1. Column defaults, so a NEW workspace is not born broken.
--   2. A one-time UPDATE for workspaces already pinned to it.
--
-- gemini-3.5-flash is what DEFAULT_CONFIG in src/analysis/types.ts already
-- names and what the analyzers fall back to when config is absent, so this
-- aligns the database with code rather than introducing a third opinion.
--
-- Historical Analysis rows keep their recorded model — it is a record of what
-- actually ran, and the cost tables retain the entry for exactly that reason.

ALTER TABLE "Workspace"
  ALTER COLUMN "analysisConfigJson"
  SET DEFAULT '{"backend":"gemini-native","fallback":"gemini-text","geminiModel":"gemini-3.5-flash"}';

ALTER TABLE "Analysis"
  ALTER COLUMN "model" SET DEFAULT 'gemini-3.5-flash';

-- Repoint any workspace still on the retired model. Targeted string replace
-- rather than overwriting the whole JSON, so a workspace that has deliberately
-- changed backend or fallback keeps those choices.
UPDATE "Workspace"
   SET "analysisConfigJson" = replace(
         "analysisConfigJson",
         '"gemini-2.5-flash-lite"',
         '"gemini-3.5-flash"'
       )
 WHERE "analysisConfigJson" LIKE '%gemini-2.5-flash-lite%';

-- Clear failure counters for the backends that were failing only because of the
-- dead model. Without this, gemini-native stays suppressed by
-- MAX_FAILURES_BEFORE_FALLBACK for up to an hour after the fix lands, and the
-- first analyses after deploy would silently be text-only for no reason.
UPDATE "Workspace"
   SET "failureCountsJson" = '{}'
 WHERE "failureCountsJson" IS NOT NULL
   AND "failureCountsJson" <> '{}';
