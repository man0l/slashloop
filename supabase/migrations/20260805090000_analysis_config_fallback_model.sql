-- New workspaces are seeded with a video-capable fallback model so that when
-- gemini-3.5-flash fails with a retryable capacity error (the observed "503
-- high demand"), analysis degrades to a different video model bucket
-- (gemini-3.5-flash-lite) before the camera-blind text-only fallback.
--
-- Column type is unchanged (String) — only the DEFAULT literal moves to match
-- prisma/schema.prisma. Existing rows keep their stored JSON; loadAnalysisConfig
-- defaults fallbackModel when the key is absent, so no backfill is required.
-- SET DEFAULT is idempotent, so this migration is safe to re-run.

ALTER TABLE "Workspace"
  ALTER COLUMN "analysisConfigJson"
  SET DEFAULT '{"backend":"gemini-native","fallback":"gemini-text","geminiModel":"gemini-3.5-flash","fallbackModel":"gemini-3.5-flash-lite"}'::text;
