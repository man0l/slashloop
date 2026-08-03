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
 * Rows whose stored media is older than their OWN workspace's window.
 *
 * The cutoff is per-workspace (retention is a setting, see §1.4), so this
 * can't compare against a single constant — it joins through Source to
 * Workspace and uses that row's value. Ordered oldest-first so a backlog
 * (someone just lowered their retention) drains the most certainly-expired
 * objects first.
 */
async function findExpired(kind: 'thumb' | 'media'): Promise<ExpiredRow[]> {
  const keyCol = kind === 'thumb' ? 'thumbKey' : 'mediaKey';
  const statusCol = kind === 'thumb' ? 'thumbStatus' : 'mediaStatus';
  const storedAtCol = kind === 'thumb' ? 'thumbStoredAt' : 'mediaStoredAt';
  const retentionCol = kind === 'thumb' ? 'thumbRetentionDays' : 'mediaRetentionDays';

  // Column names are from the literal map above, never from user input.
  return db.$queryRawUnsafe<ExpiredRow[]>(`
    SELECT v."id" AS id, v."${keyCol}" AS key
    FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId"
    JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE v."${statusCol}" = 'stored'
      AND v."${keyCol}" IS NOT NULL
      AND v."${storedAtCol}" IS NOT NULL
      AND v."${storedAtCol}" < now() - (w."${retentionCol}" * INTERVAL '1 day')
    ORDER BY v."${storedAtCol}" ASC
    LIMIT ${BATCH_LIMIT}
  `);
}

async function sweep(kind: 'thumb' | 'media', bucket: string) {
  const rows = await findExpired(kind);
  if (rows.length === 0) return { scanned: 0, deleted: 0 };

  await deleteObjects(bucket, rows.map(r => r.key));

  const ids = rows.map(r => r.id);
  await db.video.updateMany({
    where: { id: { in: ids } },
    data: kind === 'thumb'
      ? { thumbKey: null, thumbStatus: 'expired', thumbStoredAt: null }
      : { mediaKey: null, mediaStatus: 'expired', mediaStoredAt: null, mediaBytes: null },
  });

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
  return db.$queryRawUnsafe<ExpiredListingRow[]>(`
    SELECT v."id" AS id, v."thumbKey" AS "thumbKey", v."mediaKey" AS "mediaKey"
    FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId"
    JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE v."scrapedAt" < now() - (GREATEST(w."thumbRetentionDays", w."mediaRetentionDays") * INTERVAL '1 day')
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

  return { scanned: rows.length, deleted: rows.length };
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
