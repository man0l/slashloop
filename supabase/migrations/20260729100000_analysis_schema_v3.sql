-- Analysis schema v3 — recreation key moments.
--
-- v3 adds `keyMoments` to the analysis JSON: 3-6 moments written as shot-list
-- entries (framing, camera angle, lighting, wardrobe, text placement) rather
-- than as observations. See prompts/gemini-observe.v2.md and KeyMomentSchema.
--
-- Only the column default moves. Existing rows keep schemaVersion 'v2' on
-- purpose — they genuinely do not have key moments, and rewriting them to 'v3'
-- would claim data that is not there and make a future reprocessing sweep
-- (docs/media-storage-plan.md §2.3) unable to find them.
--
-- The JSON column itself needs no migration: analysisJson is text, and
-- keyMoments parses as null when absent, so v2 rows stay readable under the v3
-- schema.

ALTER TABLE "Analysis"
  ALTER COLUMN "schemaVersion" SET DEFAULT 'v3';
