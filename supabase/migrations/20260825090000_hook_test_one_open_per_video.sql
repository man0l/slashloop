-- Hook tests: at most one OPEN test per video.
--
-- "One open test per video" started as a service-level rule (findOpenTest in
-- src/lib/hook-tests.ts). That catches the calm case but not the race: a UI
-- double-click, two tabs, or agent + human starting together all pass the
-- check before either INSERT lands — two open tests, both charged. Prisma
-- cannot express a partial unique index in schema.prisma, so it lives here,
-- like the MediaJob_one_target CHECK.
--
-- Closing/winning a test removes its row from the index's scope, freeing the
-- video for the next test without touching history.

CREATE UNIQUE INDEX IF NOT EXISTS hook_test_one_open_per_video
  ON "HookTest"(("videoId"))
  WHERE "status" IN ('setup', 'picking', 'posted');
