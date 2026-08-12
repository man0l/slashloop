#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Backfill missing TikTok cover images into object storage (R2/Supabase).
//
// Videos a refresh pulled beyond THUMB_INGEST_MAX_PER_RUN used to be dropped —
// thumbStatus stayed 'none' forever and the gallery fell back to the
// short-lived TikTok CDN URL (which 410s within days). Going forward the
// overflow is queued as `thumb` jobs (src/lib/jobs.ts enqueueThumbJob); this
// one-off closes the gap for the rows already sitting in that state.
//
// Re-runs thumbnail ingest for every tiktok, non-baseline video whose thumb is
// missing. Idempotent: already-'stored' rows are excluded by the query; a row
// whose source CDN URL has already expired will fail and be marked 'failed'
// (that cover is then unrecoverable — the only copy lived behind a signed URL).
//
// Run anywhere the worker runs (it needs DATABASE_URL + storage creds):
//   bun src/scripts/backfill_thumbs.ts [--include-failed] [--limit=N] [--dry-run]
//
//   --include-failed   also retry rows previously marked 'failed'
//   --limit=N          cap how many videos to process (default: all)
//   --dry-run          list candidates and exit without ingesting
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { ingestThumbnails, type ThumbIngestTarget } from '../lib/media.js';

const args = process.argv.slice(2);
const INCLUDE_FAILED = args.includes('--include-failed');
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;

const CHUNK = 25;

async function main() {
  const statuses = INCLUDE_FAILED ? ['none', 'failed'] : ['none'];
  console.log(
    `[backfill-thumbs] start ${new Date().toISOString()} statuses=[${statuses.join(',')}]`
    + `${LIMIT ? ` limit=${LIMIT}` : ''}${DRY_RUN ? ' (dry-run)' : ''}`,
  );

  const rows = await db.video.findMany({
    where: {
      platform: 'tiktok',
      isBaselineSample: false,
      thumbStatus: { in: statuses },
      thumbKey: null,
    },
    select: {
      id: true,
      platform: true,
      thumbnailUrl: true,
      source: { select: { workspaceId: true, query: true } },
    },
    orderBy: { scrapedAt: 'desc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[backfill-thumbs] ${rows.length} candidate video(s)`);
  if (rows.length === 0) {
    console.log('[backfill-thumbs] nothing to do');
    return;
  }

  if (DRY_RUN) {
    for (const r of rows.slice(0, 50)) {
      console.log(`  ${r.id.slice(0, 8)} source=${r.source.query} thumb=${r.thumbnailUrl.slice(0, 60)}…`);
    }
    if (rows.length > 50) console.log(`  …and ${rows.length - 50} more`);
    return;
  }

  // Group by workspace — ingestThumbnails keys the storage path by workspaceId.
  const byWs = new Map<string, ThumbIngestTarget[]>();
  for (const r of rows) {
    const ws = r.source.workspaceId;
    const arr = byWs.get(ws) ?? [];
    arr.push({
      videoId: r.id,
      platform: r.platform,
      thumbnailUrl: r.thumbnailUrl,
      // coverDownloadUrl isn't persisted on the row; ingestOneThumb falls back
      // to thumbnailUrl (with TikTok referer headers).
    });
    byWs.set(ws, arr);
  }

  let stored = 0;
  let failed = 0;
  let skipped = 0;
  for (const [wsId, targets] of byWs) {
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      const res = await ingestThumbnails(wsId, chunk);
      stored += res.stored;
      failed += res.failed;
      skipped += res.skipped;
      console.log(
        `[backfill-thumbs] ws=${wsId.slice(0, 8)} ${i + chunk.length}/${targets.length}: `
        + `+${res.stored} stored, ${res.failed} failed, ${res.skipped} skipped`,
      );
    }
  }

  console.log(`[backfill-thumbs] done — stored=${stored} failed=${failed} skipped=${skipped} of ${rows.length}`);
}

main()
  .catch((e) => { console.error('[backfill-thumbs] fatal:', e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
