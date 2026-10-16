-- Workspace.category (SLA-885) — general | faceless content category.
-- Existing rows default to 'general'. Idempotent.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'general';
