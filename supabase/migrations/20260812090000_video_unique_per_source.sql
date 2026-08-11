-- Multi-tenant batching: make fan-out idempotent.
--
-- applyScrapeItems() dedupes by (sourceId, platform, externalId) with a read
-- followed by a write. That was safe while one Vercel invocation drained the
-- queue; with several VPS worker containers claiming `refresh` (WORKER_KINDS)
-- two workers can apply the SAME shared scrape to the same source and both
-- pass the existence check, inserting duplicate Video rows.
--
-- The unique index turns that race into a P2002 the writer catches and treats
-- as an update (src/lib/refresh.ts). It is also the precondition for the
-- Phase B cache, where a cached result may legitimately be applied twice.

-- 1. Collapse any duplicates that already exist, keeping the oldest row (it
--    owns the analyses/scores/thumbs) and the newest stats.
WITH ranked AS (
  SELECT "id",
         "sourceId",
         "platform",
         "externalId",
         row_number() OVER (
           PARTITION BY "sourceId", "platform", "externalId"
           ORDER BY "scrapedAt" ASC, "id" ASC
         ) AS rn
    FROM "Video"
)
DELETE FROM "Video" v
 USING ranked r
 WHERE v."id" = r."id"
   AND r.rn > 1;

-- 2. Enforce it going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "Video_sourceId_platform_externalId_key"
    ON "Video" ("sourceId", "platform", "externalId");
