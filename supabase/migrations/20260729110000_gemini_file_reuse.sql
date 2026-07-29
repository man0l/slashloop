-- Phase 2.2 — reuse the Gemini Files API upload.
--
-- See docs/media-storage-plan.md §2.2. The Files API keeps an upload ~48h and
-- returns a handle that was previously discarded after every analysis, so each
-- re-analysis re-uploaded the same bytes and re-waited for processing. With the
-- Apify download already removed by Phase 2.1, that upload is the slowest leg
-- left inside the worker's 60s budget.
--
-- Held on Video rather than Analysis, which is where §2.2 sketched it: the
-- handle describes the video, not a particular run, and this puts it beside
-- mediaKey where the same lifecycle questions already live.
--
-- Purely additive — three nullable columns, no default, no backfill. Rows
-- without them simply upload as before.

ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "geminiFileUri"       TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "geminiFileName"      TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "geminiFileExpiresAt" TIMESTAMP(3);
