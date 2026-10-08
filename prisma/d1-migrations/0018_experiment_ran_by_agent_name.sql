-- Experiment.ranBy: keep only the agent name. Rows written as
-- "agent:<name> on behalf of <user>" become "agent:<name>", matching what
-- normalizeRanBy now stores, so the exact-match ranBy filter and the
-- (workspaceId, ranBy, createdAt) index keep working for old rows.
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
UPDATE "Experiment"
SET "ranBy" = substr("ranBy", 1, instr(lower("ranBy"), ' on behalf of ') - 1)
WHERE "ranBy" LIKE 'agent:%'
  AND instr(lower("ranBy"), ' on behalf of ') > 0;
