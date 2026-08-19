-- Discover probes are not attached to a Source (nothing is tracked yet) or a
-- Video. The existing MediaJob_one_target CHECK required exactly one of
-- videoId/sourceId, which made a discover job illegal to insert.
--
-- kind='discover' is allowed to have both ids null. Every other kind still
-- needs exactly one target, so a malformed refresh/analyze enqueue still
-- fails rather than producing a job the worker cannot route.
--
-- Safe to re-run: DROP IF EXISTS then re-ADD.

ALTER TABLE "MediaJob" DROP CONSTRAINT IF EXISTS "MediaJob_one_target";

ALTER TABLE "MediaJob"
  ADD CONSTRAINT "MediaJob_one_target"
  CHECK (
    (
      "kind" = 'discover'
      AND "videoId" IS NULL
      AND "sourceId" IS NULL
    )
    OR (
      "kind" <> 'discover'
      AND (("videoId" IS NOT NULL)::int + ("sourceId" IS NOT NULL)::int = 1)
    )
  );
