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
import { subMonths } from 'date-fns';
import { db } from '../db.js';
import { scrapeSource } from './apify.js';
import { getApifyCapStatus, SpendCapExceededError } from './spend-cap.js';
import { batchScoreVideos } from '../scoring.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits } from './credits.js';
import { ingestThumbnails, type ThumbIngestTarget } from './media.js';
import { enqueueRescoreJob } from './jobs.js';

/**
 * Videos posted before this cutoff are scraped (and billed — Apify already
 * returned them) but not persisted. Discovery scrapes (hashtag/keyword, and
 * TikTok's own "top" ranking for a query) surface evergreen multi-year-old
 * content alongside anything actually fresh; without a floor the library
 * fills with videos years too old to act on. Applies to every source type,
 * including creator — a creator's own baseline is computed from whatever
 * history is in the DB (src/scoring.ts computeCreatorBaseline), so this also
 * caps how far back that baseline looks.
 */
const RECENCY_CUTOFF_MONTHS = 3;

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
  /**
   * Stable credit-ledger identity for this MediaJob, minted once at enqueue
   * (see enqueueRefreshJob). Passing the SAME opId across every retry of the
   * same job is what makes debitCredits() idempotent on a killed-and-retried
   * attempt instead of a second charge — falls back to a fresh one only for
   * callers outside the job queue (there are none left, kept for safety).
   */
  opId?: string;
  /** Pre-auth amount to debit under `opId`, minted alongside it at enqueue so
   *  every retry debits (or idempotently replays) the exact same amount. */
  preAuthCredits?: number;
  /**
   * Query Apify as if `sourceId` were a different source type/query, while
   * still attributing persisted/updated videos and billing to `sourceId`'s
   * real workspace. For rescoreStaleTooFresh (src/scoring.ts): outlier
   * scoring compares a video to its CREATOR's own baseline (computeCreator-
   * Baseline), built from that creator's videos across every source that has
   * ever found them — not from whichever hashtag/keyword source happened to
   * discover this particular video. Re-running a hashtag/keyword source's
   * own query again mostly surfaces a different set of creators each time
   * and rarely re-includes the specific stale video. Overriding to a
   * creator-scoped query targets the actual person the score is measured
   * against, regardless of which source's record-keeping this call is
   * attributed to.
   */
  sourceTypeOverride?: 'creator' | 'keyword' | 'hashtag';
  queryOverride?: string;
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

  const effectiveSourceType = opts.sourceTypeOverride ?? (source.sourceType as 'creator' | 'keyword' | 'hashtag');
  const effectiveQuery = opts.queryOverride ?? source.query;

  const limit = limitOverride ?? source.videoLimit;
  let itemsPulled = 0;
  let newVideos = 0;
  let costCents = 0;
  const errors: string[] = [];
  let rescoreQueued = false;

  const base = {
    sourceId, query: effectiveQuery, platform: source.platform, sourceType: effectiveSourceType,
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
  // opId/preAuthCredits come from the caller (the MediaJob's own stable
  // identity) whenever this is running under the job queue, so a retry after
  // a killed attempt replays the same debit instead of charging again — see
  // the opId doc comment above and enqueueRefreshJob in src/lib/jobs.ts.
  const opId = opts.opId ?? randomUUID();
  const preAuthCredits = opts.preAuthCredits ?? Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * limit);
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
      sourceType: effectiveSourceType,
      query: effectiveQuery,
      limit,
    });

    itemsPulled = result.items.length;
    costCents = result.costCents;

    // The actor signals a bad query with an in-dataset record, not a failed run.
    if (result.notices.length > 0) errors.push(...result.notices);

    // Set as soon as the Apify cost is incurred, so settlement stays correct
    // even if persistence or scoring throws below.
    actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * itemsPulled);

    const recencyCutoff = subMonths(new Date(), RECENCY_CUTOFF_MONTHS);
    let skippedOld = 0;

    // A creator/query override means this call exists purely to keep a
    // baseline fresh (rescoreStaleTooFresh), not to track new content — see
    // Video.isBaselineSample in prisma/schema.prisma.
    const isBaselineOnly = !!opts.sourceTypeOverride;

    let updatedVideos = 0;

    const thumbTargets: ThumbIngestTarget[] = [];
    for (const nv of result.items) {
      if (new Date(nv.postedAt) < recencyCutoff) {
        skippedOld++;
        continue;
      }

      const existing = await db.video.findFirst({
        where: { platform: nv.platform, externalId: nv.externalId },
        select: { id: true },
      });
      if (existing) {
        // The scrape just returned this video's CURRENT stats for free (no
        // extra Apify call) — previously discarded here entirely, which is
        // why a video's views/score never moved past whatever they were the
        // first time it was scraped. A video posted <48h ago gets forced to
        // 0x/too_fresh (src/scoring.ts) specifically BECAUSE its early view
        // count isn't meaningful yet; refreshing it here is what makes the
        // eventual rescore (once 48h passes) reflect its real performance
        // instead of recomputing the same stale, immature number forever.
        await db.video.update({
          where: { id: existing.id },
          data: {
            views: nv.views,
            likes: nv.likes,
            comments: nv.comments,
            shares: nv.shares,
            saves: nv.saves,
            creatorFollowers: nv.creatorFollowers,
            // Only a REAL (non-baseline-only) refresh promotes a video to
            // visible — a baseline-only call re-touching an already-visible
            // video must never hide it, so it leaves the flag untouched
            // rather than writing `true` here.
            ...(isBaselineOnly ? {} : { isBaselineSample: false }),
          },
        });
        updatedVideos++;
        continue;
      }

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
          isBaselineSample: isBaselineOnly,
        },
        select: { id: true },
      });
      newVideos++;
      // Thumbnails are for display — a baseline-only video is never shown
      // anywhere, so ingesting one would just spend storage/ingest budget
      // for nothing.
      if (!isBaselineOnly) {
        thumbTargets.push({
          videoId: created.id,
          platform: nv.platform,
          thumbnailUrl: nv.thumbnailUrl,
          coverDownloadUrl: nv.coverDownloadUrl,
        });
      }
    }

    if (skippedOld > 0) {
      errors.push(
        `Recency filter: ${skippedOld} of ${result.items.length} scraped videos were older than `
        + `${RECENCY_CUTOFF_MONTHS} months and were not saved (cosmetic only)`,
      );
    }

    // SCORING BEFORE THUMBNAILS. Order matters more than it looks.
    //
    // Scoring is what the refresh was bought for — an unscored video is
    // invisible to every ranking in the product. Thumbnails are cosmetic: a
    // missing one shows a grey box. Running ingest first put the cosmetic step
    // ahead of the essential one, and when the worker was killed mid-ingest the
    // videos landed unscored. Observed live: 21 videos persisted, thumbnails
    // stored, scoring never reached, and a 1.2M-view outlier sat with
    // score: null until someone rescored by hand.
    // Also rescore on updatedVideos alone (no new videos this run): an
    // existing video's views/baseline can have moved even when nothing new
    // was found, and batchScoreVideos re-scores the whole source anyway.
    if (newVideos > 0 || updatedVideos > 0) {
      await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
    }

    // Bounded, and last. Ingest cost scales with the number of new videos,
    // which is exactly when the budget is tightest, so past this many it is
    // left to the retention/backfill path rather than risking the invocation.
    // resolveThumbUrl already falls back to the source CDN, so an un-ingested
    // thumbnail degrades rather than breaks.
    const THUMB_INGEST_MAX_PER_RUN = 15;
    if (thumbTargets.length > 0) {
      const batch = thumbTargets.slice(0, THUMB_INGEST_MAX_PER_RUN);
      const deferred = thumbTargets.length - batch.length;
      const ingest = await ingestThumbnails(workspaceId, batch);
      if (ingest.failed > 0) {
        errors.push(`Thumbnail ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
      }
      if (deferred > 0) {
        errors.push(`Thumbnail ingest: ${deferred} deferred to stay inside the worker budget (cosmetic only)`);
      }
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
  if (effectiveSourceType === 'creator' && itemsPulled > 0) {
    try {
      await enqueueRescoreJob({
        workspaceId,
        sourceId,
        payload: { creatorHandle: effectiveQuery },
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
