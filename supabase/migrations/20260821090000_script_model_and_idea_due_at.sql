-- Scripts (generate_script) + Idea.dueAt (posting queue).
--
-- 1. "Script" table — generated app-promo scripts, one row per generation,
--    FK'd to the Analysis they were based on.
-- 2. "Idea"."dueAt" — nullable planned-post date backing get_idea_queue.
--
-- Every statement is guarded so re-running is a no-op (Supabase applies
-- migrations on merge; see README "Schema changes").

CREATE TABLE IF NOT EXISTS "Script" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "scriptJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Script_analysisId_idx" ON "Script"("analysisId");
CREATE INDEX IF NOT EXISTS "Script_format_idx" ON "Script"("format");

-- ADD CONSTRAINT has no IF NOT EXISTS, so look it up in the catalog first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Script_analysisId_fkey'
  ) THEN
    ALTER TABLE "Script" ADD CONSTRAINT "Script_analysisId_fkey"
      FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);
