// GET /api/cron/media-retention — daily retention sweep for stored media.
//
// Supabase Storage exposes no object lifecycle rules (unlike S3 and R2), so
// expiry is a job we own. See docs/media-storage-plan.md §1.8.
//
// Ordering matters: delete the objects FIRST, then null the DB columns. If the
// process dies in between we leak an object but never claim to still have one,
// and the orphan sweep reclaims it. The reverse order would leave rows
// pointing at objects that are gone — broken images in the feed.
//
// Guarded by CRON_SECRET. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// automatically when that env var is set on the project.

import { db } from '../../src/db.js';
import { dbDialect, rawBatch, type RawStatement } from '../../src/store.js';
import { deleteObjects, isStorageEnabled, thumbBucket, mediaBucket } from '../../src/lib/storage.js';

/** Max rows handled per bucket per run. A backlog drains over several days. */
const BATCH_LIMIT = 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ExpiredRow = { id: string; key: string };

/**
 * Column-name map + the WHERE for "expired stored media of this kind".
 *
 * The cutoff is per-workspace (retention is a setting, see §1.4), so this
 * can't compare against a single constant — it joins through Source to
 * Workspace and uses that row's value. SQLite: julianday() parses Prisma's
 * stored ISO strings; per-row retention days forces the date math into SQL
 * (a bound cutoff can't vary by row). The WHERE is shared VERBATIM by
 * findExpired()'s SELECT and sweep()'s column-nulling UPDATE (same v/s/w
 * aliases) so the two can never drift apart.
 */
function expiredColumns(kind: 'thumb' | 'media') {
  const keyCol = kind === 'thumb' ? 'thumbKey' : 'mediaKey';
  const statusCol = kind === 'thumb' ? 'thumbStatus' : 'mediaStatus';
  const storedAtCol = kind === 'thumb' ? 'thumbStoredAt' : 'mediaStoredAt';
  const retentionCol = kind === 'thumb' ? 'thumbRetentionDays' : 'mediaRetentionDays';
  // Column names are from the literal map above, never from user input.
  const cutoff = dbDialect() === 'sqlite'
    ? `julianday(v."${storedAtCol}") < julianday('now') - w."${retentionCol}"`
    : `v."${storedAtCol}" < now() - (w."${retentionCol}" * INTERVAL '1 day')`;
  const where = `
    v."${statusCol}" = 'stored'
    AND v."${keyCol}" IS NOT NULL
    AND v."${storedAtCol}" IS NOT NULL
    AND ${cutoff}`;
  return { keyCol, statusCol, storedAtCol, where };
}

async function findExpired(kind: 'thumb' | 'media'): Promise<ExpiredRow[]> {
  const { keyCol, storedAtCol, where } = expiredColumns(kind);
  return db.$queryRawUnsafe<ExpiredRow[]>(`
    SELECT v."id" AS id, v."${keyCol}" AS key
    FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId"
    JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE ${where}
    ORDER BY v."${storedAtCol}" ASC
    LIMIT ${BATCH_LIMIT}
  `);
}

async function sweep(kind: 'thumb' | 'media', bucket: string) {
  const rows = await findExpired(kind);
  if (rows.length === 0) return { scanned: 0, deleted: 0 };

  await deleteObjects(bucket, rows.map(r => r.key));

  if (dbDialect() === 'sqlite') {
    // Param-free re-selection UPDATE — D1 caps bound parameters at ~98 per
    // statement and a full BATCH_LIMIT run produces up to 1000 ids, which
    // overflowed Prisma's `in: ids` here: objects got deleted, the columns
    // stayed 'stored' (found live 2026-09-01). Same WHERE as findExpired, so
    // the UPDATE hits exactly the rows whose objects were just deleted.
    const { keyCol, statusCol, storedAtCol, where } = expiredColumns(kind);
    const clear = kind === 'thumb'
      ? `"${keyCol}" = NULL, "${statusCol}" = 'expired', "${storedAtCol}" = NULL`
      : `"${keyCol}" = NULL, "${statusCol}" = 'expired', "${storedAtCol}" = NULL, "mediaBytes" = NULL`;
    await rawBatch([{
      sql: `UPDATE "Video" SET ${clear} WHERE "id" IN (
        SELECT v."id" FROM "Video" v
        JOIN "Source" s ON s."id" = v."sourceId"
        JOIN "Workspace" w ON w."id" = s."workspaceId"
        WHERE ${where}
        ORDER BY v."${storedAtCol}" ASC
        LIMIT ${BATCH_LIMIT}
      )`,
    }]);
  } else {
    const ids = rows.map(r => r.id);
    await db.video.updateMany({
      where: { id: { in: ids } },
      data: kind === 'thumb'
        ? { thumbKey: null, thumbStatus: 'expired', thumbStoredAt: null }
        : { mediaKey: null, mediaStatus: 'expired', mediaStoredAt: null, mediaBytes: null },
    });
  }

  return { scanned: rows.length, deleted: rows.length };
}

type ExpiredListingRow = { id: string; thumbKey: string | null; mediaKey: string | null };

/**
 * Rows whose entire LISTING (not just its stored media) is past its
 * workspace's retention window. Plan-level retention is not only a media
 * cost lever (§ above) — for the free tier especially, a video's presence in
 * the feed/gallery is itself the thing that expires, same as Supabase's own
 * object-level expiry but applied to the row.
 *
 * The cutoff uses the WIDER of the workspace's two retention columns so a
 * listing is never dropped while either asset window could still be legally
 * alive (e.g. someone set mediaRetentionDays below thumbRetentionDays by
 * hand via update_settings).
 */
async function findExpiredListings(): Promise<ExpiredListingRow[]> {
  // See findExpired for the SQLite cutoff (julianday; MAX() as GREATEST).
  const cutoff = dbDialect() === 'sqlite'
    ? `julianday(v."scrapedAt") < julianday('now') - MAX(w."thumbRetentionDays", w."mediaRetentionDays")`
    : `v."scrapedAt" < now() - (GREATEST(w."thumbRetentionDays", w."mediaRetentionDays") * INTERVAL '1 day')`;
  return db.$queryRawUnsafe<ExpiredListingRow[]>(`
    SELECT v."id" AS id, v."thumbKey" AS "thumbKey", v."mediaKey" AS "mediaKey"
    FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId"
    JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE ${cutoff}
    ORDER BY v."scrapedAt" ASC
    LIMIT ${BATCH_LIMIT}
  `);
}

/**
 * Deletes expired video listings entirely, cascading by hand through every
 * table that references Video (none of these FKs cascade at the DB level —
 * see prisma/schema.prisma). Order matters: Brief -> {Hook, Idea} ->
 * {SwipeEntry, Score, MediaJob, Analysis} -> Video, so a row is never
 * deleted while something still points at it.
 *
 * This removes anything built from the video too — analysis, hooks, ideas,
 * exported briefs, and board saves. There is deliberately no "but it's
 * saved to a Board" exemption: retention is a plan-level cost control, and a
 * video surviving past it because someone swiped it would make the limit
 * meaningless. Saving a video is not the same product as archiving it.
 */
async function sweepExpiredListings(): Promise<{ scanned: number; deleted: number }> {
  const rows = await findExpiredListings();
  if (rows.length === 0) return { scanned: 0, deleted: 0 };

  const ids = rows.map(r => r.id);
  const thumbKeys = rows.map(r => r.thumbKey).filter((k): k is string => Boolean(k));
  const mediaKeys = rows.map(r => r.mediaKey).filter((k): k is string => Boolean(k));

  // Storage objects first (same ordering rationale as sweep() above): if the
  // process dies before the DB transaction below, we leak nothing but an
  // orphaned row, which the next run's findExpiredListings() picks up again
  // (scrapedAt doesn't change). The reverse order could leave a deleted row
  // whose objects never get cleaned up.
  if (thumbKeys.length > 0) await deleteObjects(thumbBucket(), thumbKeys);
  if (mediaKeys.length > 0) await deleteObjects(mediaBucket(), mediaKeys);

  if (dbDialect() === 'sqlite') {
    await sweepExpiredListingsSqlite(ids);
  } else {
    await db.$transaction([
      // A Brief can reach an expiring video through either its analysis or its
      // (optional) idea — either path needs to be gone before Analysis/Idea can go.
      db.brief.deleteMany({
        where: { OR: [{ analysis: { videoId: { in: ids } } }, { idea: { videoId: { in: ids } } }] },
      }),
      db.hook.deleteMany({ where: { videoId: { in: ids } } }),
      db.idea.deleteMany({ where: { videoId: { in: ids } } }),
      db.swipeEntry.deleteMany({ where: { videoId: { in: ids } } }),
      db.score.deleteMany({ where: { videoId: { in: ids } } }),
      db.mediaJob.deleteMany({ where: { videoId: { in: ids } } }),
      db.analysis.deleteMany({ where: { videoId: { in: ids } } }),
      db.video.deleteMany({ where: { id: { in: ids } } }),
    ]);
  }

  return { scanned: rows.length, deleted: rows.length };
}

/**
 * SQLite/D1 form of the cascade above. `$transaction([...])` has no D1
 * equivalent (no client transactions), so the same deletes run as ONE atomic
 * batch. Every statement re-runs the SAME LIMIT-ed selection
 * (sweepExpiredListings uses) instead of binding 1000 ids — D1 caps bound
 * parameters at 100 per query, and inside one batch the selection sees a
 * consistent snapshot, so the deletes hit exactly the swept rows.
 */
async function sweepExpiredListingsSqlite(ids: string[]): Promise<void> {
  // The selection is the same query findExpiredListings ran; ids.length ≤
  // BATCH_LIMIT is what defines the sweep's boundary.
  void ids;
  const selection = `
    SELECT v."id" FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId"
    JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE julianday(v."scrapedAt") < julianday('now') - MAX(w."thumbRetentionDays", w."mediaRetentionDays")
    ORDER BY v."scrapedAt" ASC
    LIMIT ${BATCH_LIMIT}`;

  const statements: RawStatement[] = [
    // A Brief can reach an expiring video through either its analysis or its
    // (optional) idea — either path must go before Analysis/Idea can.
    {
      sql: `DELETE FROM "Brief" WHERE "id" IN (
        SELECT b."id" FROM "Brief" b
        LEFT JOIN "Analysis" ba ON ba."id" = b."analysisId"
        LEFT JOIN "Idea" bi ON bi."id" = b."ideaId"
        WHERE ba."videoId" IN (${selection}) OR bi."videoId" IN (${selection})
      )`,
    },
    { sql: `DELETE FROM "Hook" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "Idea" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "SwipeEntry" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "Score" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "MediaJob" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "Analysis" WHERE "videoId" IN (${selection})` },
    { sql: `DELETE FROM "Video" WHERE "id" IN (${selection})` },
  ];
  await rawBatch(statements);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(500, { error: 'CRON_SECRET is not configured' });

  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' });

  if (!isStorageEnabled()) {
    return json(200, { skipped: 'storage_disabled' });
  }

  const started = Date.now();
  const errors: string[] = [];

  let thumbs = { scanned: 0, deleted: 0 };
  let media = { scanned: 0, deleted: 0 };
  let listings = { scanned: 0, deleted: 0 };

  // Independent sweeps: a bucket-level (or table-level) failure on one must
  // not stop the others.
  try {
    thumbs = await sweep('thumb', thumbBucket());
  } catch (err) {
    errors.push(`thumbs: ${(err as Error).message}`);
  }
  try {
    media = await sweep('media', mediaBucket());
  } catch (err) {
    errors.push(`media: ${(err as Error).message}`);
  }
  // Runs after the two above: a listing that just had its media swept this
  // same run is also fair game for full deletion if its scrapedAt is old
  // enough — no need to wait for the next run.
  try {
    listings = await sweepExpiredListings();
  } catch (err) {
    errors.push(`listings: ${(err as Error).message}`);
  }

  const body = {
    thumbs,
    media,
    listings,
    errors,
    // A full batch means there is more to do — the next run picks it up.
    moreToSweep: thumbs.scanned >= BATCH_LIMIT || media.scanned >= BATCH_LIMIT || listings.scanned >= BATCH_LIMIT,
    durationMs: Date.now() - started,
  };

  console.log(`[retention] ${JSON.stringify(body)}`);
  return json(errors.length > 0 ? 500 : 200, body);
}
