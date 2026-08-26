-- HookTest.winnerLabel — which opening won when a test closes as 'won' ("C").
-- The verdict is manual until Phase 4 auto-scores versions against the owner
-- baseline, but storing the label lets the panel header, gallery badge and
-- /tests index say "C won" instead of a bare "won".
ALTER TABLE "HookTest" ADD COLUMN IF NOT EXISTS "winnerLabel" TEXT;
