// ---------------------------------------------------------------------------
// runRefresh — the scrape/persist/score pipeline, callable from two places.
//
// Extracted from the refresh_source tool handler so the queue worker can run
// the identical pipeline. Two copies of credit pre-authorisation and refund
// settlement is exactly the kind of duplication that silently diverges and
// starts billing people twice.
//
// Why it moved at all: this pipeline does not fit an MCP tool call. A scrape
// consumes most of api/mcp.ts's 60s maxDuration, and anything after it gets
// killed. Observed in production — a refresh completed and billed (10 pulled,
// 9 new) while the rescore that the refresh was bought FOR never ran, leaving
// the outlier on its stale `estimated` score. Running the same function from a
// worker invocation gives the whole budget to one job.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { scrapeSource } from './apify.js';
import { getApifyCapStatus, SpendCapExceededError } from './spend-cap.js';
import { batchScoreVideos } from '../scoring.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits } from './credits.js';
import { ingestThumbnails, type ThumbIngestTarget } from './media.js';
import { enqueueRescoreJob } from './jobs.js';

export interface RunRefreshResult {
  ok: boolean;
  /** Set when the run was refused before any spend (cap breach, no credits). */
  refusal?: 'cap_breached' | 'insufficient_credits' | 'source_not_found';
  refusalDetail?: unknown;
  sourceId: string;
  query: string;
  platform: string;
  sourceType: string;
  itemsPulled: number;
  newVideos: number;
  costCents: number;
  creditsCharged: number;
  creditsRemaining: number;
  errors: string[];
  /** True when a follow-up rescore job was queued (creator refreshes only). */
  rescoreQueued: boolean;
  durationMs: number;
}

/**
 * Pre-authorise, scrape, persist, score, settle.
 *
 * Never throws for expected failures — they come back on `refusal`/`errors` so
 * both callers can report identically. The credit contract is unchanged from
 * the original inline version: debit the worst case up front, refund down to
 * actual usage, refund in full on a cap breach.
 */
export async function runRefresh(opts: {
  workspaceId: string;
  sourceId: string;
  limitOverride?: number;
}): Promise<RunRefreshResult> {
  const { workspaceId, sourceId, limitOverride } = opts;
  const startTime = Date.now();

  const source = await db.source.findFirst({ where: { id: sourceId, workspaceId } });
  if (!source) {
    return {
      ok: false, refusal: 'source_not_found', sourceId, query: '', platform: '', sourceType: '',
      itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
      errors: ['Source not found'], rescoreQueued: false, durationMs: Date.now() - startTime,
    };
  }

  const limit = limitOverride ?? source.videoLimit;
  let itemsPulled = 0;
  let newVideos = 0;
  let costCents = 0;
  const errors: string[] = [];
  let rescoreQueued = false;

  const base = {
    sourceId, query: source.query, platform: source.platform, sourceType: source.sourceType,
  };

  // Platform-wide Apify circuit breaker, unrelated to this workspace's credits.
  if (source.platform !== 'shorts') {
    const capStatus = await getApifyCapStatus(workspaceId);
    if (capStatus.breached) {
      return {
        ok: false, refusal: 'cap_breached', refusalDetail: capStatus, ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
        errors: ['Apify spend cap already breached'], rescoreQueued: false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Pre-authorise the worst case (a full `limit` of videos), refunded below.
  const opId = randomUUID();
  const preAuthCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * limit);
  let creditBalance;
  try {
    creditBalance = await debitCredits(workspaceId, preAuthCredits, 'refresh_source', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return {
        ok: false, refusal: 'insufficient_credits',
        refusalDetail: { required: preAuthCredits, message: err.message }, ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
        errors: [err.message], rescoreQueued: false, durationMs: Date.now() - startTime,
      };
    }
    throw err;
  }
  let actualCredits = 0;

  try {
    const result = await scrapeSource({
      workspaceId,
      platform: source.platform,
      sourceType: source.sourceType as 'creator' | 'keyword' | 'hashtag',
      query: source.query,
      limit,
    });

    itemsPulled = result.items.length;
    costCents = result.costCents;

    // The actor signals a bad query with an in-dataset record, not a failed run.
    if (result.notices.length > 0) errors.push(...result.notices);

    // Set as soon as the Apify cost is incurred, so settlement stays correct
    // even if persistence or scoring throws below.
    actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * itemsPulled);

    const thumbTargets: ThumbIngestTarget[] = [];
    for (const nv of result.items) {
      const existing = await db.video.findFirst({
        where: { platform: nv.platform, externalId: nv.externalId },
        select: { id: true },
      });
      if (existing) continue;

      const created = await db.video.create({
        data: {
          sourceId,
          platform: nv.platform,
          externalId: nv.externalId,
          url: nv.url,
          thumbnailUrl: nv.thumbnailUrl,
          creatorHandle: nv.creatorHandle,
          creatorFollowers: nv.creatorFollowers,
          caption: nv.caption,
          postedAt: new Date(nv.postedAt),
          views: nv.views,
          likes: nv.likes,
          comments: nv.comments,
          shares: nv.shares,
          saves: nv.saves,
          durationSec: nv.durationSec,
          transcript: nv.transcript,
          transcriptSource: nv.transcriptSource,
          rawJson: JSON.stringify(nv.raw),
        },
        select: { id: true },
      });
      newVideos++;
      thumbTargets.push({
        videoId: created.id,
        platform: nv.platform,
        thumbnailUrl: nv.thumbnailUrl,
        coverDownloadUrl: nv.coverDownloadUrl,
      });
    }

    // Batched deliberately — 50 sequential round-trips would not fit the
    // function budget. Never throws: a missing thumbnail must not fail a
    // refresh that has already paid Apify.
    if (thumbTargets.length > 0) {
      const ingest = await ingestThumbnails(workspaceId, thumbTargets);
      if (ingest.failed > 0) {
        errors.push(`Thumbnail ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
      }
    }

    if (newVideos > 0) {
      await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
    }
  } catch (err) {
    if (err instanceof SpendCapExceededError) {
      creditBalance = await refundCredits(workspaceId, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed');
      return {
        ok: false, refusal: 'cap_breached',
        refusalDetail: await getApifyCapStatus(workspaceId), ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
        creditsRemaining: creditBalance.total,
        errors: [err.message], rescoreQueued: false, durationMs: Date.now() - startTime,
      };
    }
    errors.push((err as Error).message);
  }

  // Settle down to actual usage.
  const refundAmount = preAuthCredits - actualCredits;
  if (refundAmount > 0) {
    creditBalance = await refundCredits(workspaceId, refundAmount, 'refresh_source', `${opId}:settle`, 'usage_settlement');
  }

  await db.refreshRun.create({
    data: { sourceId, itemsPulled, newVideos, errorsJson: JSON.stringify(errors), costCents, ranAt: new Date() },
  });
  await db.source.update({ where: { id: sourceId }, data: { lastRefreshedAt: new Date() } });

  // Refreshing a CREATOR source is the moment their history can cross
  // CREATOR_BASELINE_MIN_SAMPLE, which changes the score of their videos in
  // OTHER sources (the hashtag scrape that surfaced them). batchScoreVideos
  // above is scoped to this source only, so those rows would otherwise keep a
  // stale `estimated` score computed against a source median.
  //
  // ENQUEUED rather than run here. Doing it inline is what kept failing: on a
  // measured run the scrape, persist and scoring finished 48.2s into the 60s
  // worker, leaving 11.3s to rescore a 30-video hashtag source. It was killed
  // every time, so the refresh was billed and the score never moved.
  //
  // As its own job it gets a full invocation, and because rescoring is free
  // (no Apify, no credits) a retry costs nothing.
  if (source.sourceType === 'creator' && itemsPulled > 0) {
    try {
      await enqueueRescoreJob({
        workspaceId,
        sourceId,
        payload: { creatorHandle: source.query },
      });
      rescoreQueued = true;
    } catch (err) {
      errors.push(`could not queue rescore: ${(err as Error).message}`);
    }
  }

  return {
    ok: true, ...base,
    itemsPulled, newVideos, costCents,
    creditsCharged: actualCredits,
    creditsRemaining: creditBalance?.total ?? 0,
    errors, rescoreQueued,
    durationMs: Date.now() - startTime,
  };
}
