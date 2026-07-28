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

  // Independent sweeps: a bucket-level failure on one must not stop the other.
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

  const body = {
    thumbs,
    media,
    errors,
    // A full batch means there is more to do — the next run picks it up.
    moreToSweep: thumbs.scanned >= BATCH_LIMIT || media.scanned >= BATCH_LIMIT,
    durationMs: Date.now() - started,
  };

  console.log(`[retention] ${JSON.stringify(body)}`);
  return json(errors.length > 0 ? 500 : 200, body);
}
