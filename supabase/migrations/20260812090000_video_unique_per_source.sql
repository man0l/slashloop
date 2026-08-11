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
-- Phase B result cache, where a cached result may legitimately be applied
-- twice.
--
-- BEFORE RUNNING, see how much work step 1 has to do:
--
--   SELECT count(*) AS duplicate_rows FROM (
--     SELECT "sourceId", "platform", "externalId", count(*) AS n
--       FROM "Video" GROUP BY 1,2,3 HAVING count(*) > 1
--   ) d;
--
-- Run the whole file in ONE transaction (supabase db push does this; in the
-- SQL editor paste it as a single script). Re-running it is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Map every duplicate to the row we keep.
--
-- Keeper = oldest by scrapedAt. It is the row analyses, hooks and swipe
-- entries were attached to, and the row whose id is already in any URL a user
-- has open. Children of the losers are RE-POINTED at it, not deleted: Score /
-- Analysis / Hook / SwipeEntry / Idea all carry ON DELETE RESTRICT foreign
-- keys, so deleting a duplicate that has any of them would abort the whole
-- migration.
-- ---------------------------------------------------------------------------
-- A session temp table, NOT `ON COMMIT DROP`: pasted into the SQL editor in
-- autocommit each statement commits on its own, and an ON COMMIT DROP table
-- would vanish before step 2 could read it.
DROP TABLE IF EXISTS _video_dup_map;
CREATE TEMP TABLE _video_dup_map AS
WITH ranked AS (
  SELECT "id",
         first_value("id") OVER (
           PARTITION BY "sourceId", "platform", "externalId"
           ORDER BY "scrapedAt" ASC, "id" ASC
         ) AS keeper_id,
         row_number() OVER (
           PARTITION BY "sourceId", "platform", "externalId"
           ORDER BY "scrapedAt" ASC, "id" ASC
         ) AS rn
    FROM "Video"
)
SELECT "id" AS dup_id, keeper_id FROM ranked WHERE rn > 1;

-- ---------------------------------------------------------------------------
-- 2. Re-point children.
--
-- Score (videoId is its PRIMARY KEY) and SwipeEntry (unique boardId+videoId)
-- can only move when the keeper does not already have one; the loser's copy is
-- redundant by definition, so it is dropped in that case.
-- ---------------------------------------------------------------------------
UPDATE "Score" s
   SET "videoId" = m.keeper_id
  FROM _video_dup_map m
 WHERE s."videoId" = m.dup_id
   AND NOT EXISTS (SELECT 1 FROM "Score" k WHERE k."videoId" = m.keeper_id);

DELETE FROM "Score" s USING _video_dup_map m WHERE s."videoId" = m.dup_id;

UPDATE "SwipeEntry" e
   SET "videoId" = m.keeper_id
  FROM _video_dup_map m
 WHERE e."videoId" = m.dup_id
   AND NOT EXISTS (
     SELECT 1 FROM "SwipeEntry" k
      WHERE k."videoId" = m.keeper_id AND k."boardId" = e."boardId"
   );

DELETE FROM "SwipeEntry" e USING _video_dup_map m WHERE e."videoId" = m.dup_id;

-- Plain many-to-one children: always safe to move.
UPDATE "Analysis" a SET "videoId" = m.keeper_id FROM _video_dup_map m WHERE a."videoId" = m.dup_id;
UPDATE "Hook"     h SET "videoId" = m.keeper_id FROM _video_dup_map m WHERE h."videoId" = m.dup_id;
UPDATE "Idea"     i SET "videoId" = m.keeper_id FROM _video_dup_map m WHERE i."videoId" = m.dup_id;

-- MediaJob.videoId has no foreign key, but a dangling id would make the
-- gallery's "why can't this video be fetched?" lookup point at nothing.
UPDATE "MediaJob" j SET "videoId" = m.keeper_id FROM _video_dup_map m WHERE j."videoId" = m.dup_id;

-- ---------------------------------------------------------------------------
-- 3. Drop the losers.
--
-- Their thumbKey/mediaKey objects stay in storage as orphans. That is
-- deliberate: the retention sweeper is the only thing that should delete from
-- buckets, and a migration that touches storage cannot be rolled back.
-- ---------------------------------------------------------------------------
DELETE FROM "Video" v USING _video_dup_map m WHERE v."id" = m.dup_id;

-- ---------------------------------------------------------------------------
-- 4. Enforce it going forward.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "Video_sourceId_platform_externalId_key"
    ON "Video" ("sourceId", "platform", "externalId");

DROP TABLE IF EXISTS _video_dup_map;
