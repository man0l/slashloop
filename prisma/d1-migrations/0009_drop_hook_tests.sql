-- Hook-test feature removed: drop HookVersion (child) then HookTest.
-- No data migration — test drafts are disposable by design.
DROP TABLE IF EXISTS "HookVersion";
DROP TABLE IF EXISTS "HookTest";
