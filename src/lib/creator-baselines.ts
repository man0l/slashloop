// ---------------------------------------------------------------------------
// After a hashtag/keyword scrape, each discovery video is usually the ONLY
// row we have for that creator. Scoring then uses the source median and a
// 1.8M-view post in a 800-view tag prints as 2262x "estimated".
//
// Fix: if we hold fewer than CREATOR_BASELINE_MIN_SAMPLE videos for a
// creator, queue a solo creator scrape (5 more videos) on the refresh
// worker. When it lands, batchScoreVideos turns those estimates into actuals.
// Baseline-only scrapes must not re-enter this path (isBaselineOnly).
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { chunked } from '../store.js';
import { CREATOR_BASELINE_MIN_SAMPLE, BASELINE_RESCRAPE_COOLDOWN_MS } from '../scoring.js';
import { CREDIT_COSTS, creditBalance } from './credits.js';
import { enqueueRefreshJob, parseRefreshJobPayload } from './jobs.js';

/** Extra videos to pull when a hashtag hit is the only history we have. */
export const CREATOR_HISTORY_EXTRA = 5;

export function needsCreatorHistory(held: number): boolean {
  return held < CREATOR_BASELINE_MIN_SAMPLE;
}

export function creatorsNeedingHistory(
  creators: { handle: string; platform: string; held: number }[],
): { handle: string; platform: string; held: number }[] {
  return creators.filter(c => needsCreatorHistory(c.held));
}

export async function enqueueMissingCreatorBaselines(opts: {
  workspaceId: string;
  sourceId: string;
}): Promise<{ queued: number; skipped: number; handles: string[] }> {
  const empty = { queued: 0, skipped: 0, handles: [] as string[] };
  const source = await db.source.findUnique({
    where: { id: opts.sourceId },
    select: { sourceType: true, platform: true },
  });
  if (!source || (source.sourceType !== 'hashtag' && source.sourceType !== 'keyword')) {
    return empty;
  }

  const videos = await db.video.findMany({
    where: { sourceId: opts.sourceId, isBaselineSample: false },
    select: { creatorHandle: true, platform: true },
  });
  const unique = new Map<string, { handle: string; platform: string }>();
  for (const v of videos) {
    if (!v.creatorHandle) continue;
    unique.set(`${v.creatorHandle}__${v.platform}`, { handle: v.creatorHandle, platform: v.platform });
  }
  if (unique.size === 0) return empty;

  const handles = [...unique.values()].map(c => c.handle);
  // Chunked: D1 caps bound parameters at ~100 and a hashtag source can hold
  // hundreds of distinct creators.
  const heldBy = new Map<string, number>();
  await chunked(handles, async (chunk) => {
    if (!chunk.length) return;
    const counts = await db.video.groupBy({
      by: ['creatorHandle', 'platform'],
      where: { creatorHandle: { in: chunk }, platform: source.platform },
      _count: { _all: true },
    });
    for (const r of counts) {
      heldBy.set(`${r.creatorHandle}__${r.platform}`, Number(r._count?._all ?? 0));
    }
  });

  const pending = await db.mediaJob.findMany({
    where: {
      sourceId: opts.sourceId,
      kind: 'refresh',
      status: { in: ['queued', 'running'] },
    },
    select: { payloadJson: true },
  });
  // A baseline scrape that FAILED recently counts as pending too. Without
  // this, a creator whose top-up keeps failing (out of credits, broken actor)
  // was re-enqueued by every subsequent refresh of this source — each row
  // then burning its claim/debit/fail lives against D1 for nothing.
  const recentlyFailed = await db.mediaJob.findMany({
    where: {
      sourceId: opts.sourceId,
      kind: 'refresh',
      status: 'failed',
      finishedAt: { gt: new Date(Date.now() - BASELINE_RESCRAPE_COOLDOWN_MS) },
    },
    select: { payloadJson: true },
  });
  const already = new Set(
    [...pending, ...recentlyFailed]
      .map(j => parseRefreshJobPayload(j.payloadJson).queryOverride)
      .filter((h): h is string => Boolean(h)),
  );

  const needed = creatorsNeedingHistory(
    [...unique.values()].map(c => ({
      ...c,
      held: heldBy.get(`${c.handle}__${c.platform}`) ?? 0,
    })),
  );

  // Same gate the sweep path has: a workspace that cannot cover the per-creator
  // pre-auth gets no jobs — they would all be claimed, refused by debitCredits
  // and terminally failed within seconds, pure D1 churn. The next refresh of
  // this source after a top-up re-runs this enqueue.
  const baselineCost = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * CREATOR_HISTORY_EXTRA);
  const affordable = await creditBalance(opts.workspaceId)
    .then((b) => b.total >= baselineCost)
    .catch(() => false);
  if (!affordable) {
    return { queued: 0, skipped: needed.length, handles: [] };
  }

  let queued = 0;
  let skipped = unique.size - needed.length;
  const queuedHandles: string[] = [];
  for (const c of needed) {
    if (already.has(c.handle)) {
      skipped++;
      continue;
    }
    await enqueueRefreshJob({
      workspaceId: opts.workspaceId,
      sourceId: opts.sourceId,
      videoLimit: CREATOR_HISTORY_EXTRA,
      deadlineAt: new Date(Date.now() + 30 * 60 * 1000),
      payload: {
        limitOverride: CREATOR_HISTORY_EXTRA,
        sourceTypeOverride: 'creator',
        queryOverride: c.handle,
      },
    });
    queued++;
    queuedHandles.push(c.handle);
  }

  return { queued, skipped, handles: queuedHandles };
}
