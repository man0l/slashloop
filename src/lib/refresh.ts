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
//
// Phase A multi-tenant batching: runBatchedRefresh() scrapes once for a
// canonical (platform, type, query) and fans out applyScrapeItems() to every
// subscriber workspace/source. Credits stay per-workspace.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { subMonths } from 'date-fns';
import { db } from '../db.js';
import { scrapeSource, scrapeCapKind, trafficStatus, type ScrapeResult } from './scrapers/index.js';
import { getApifyCapStatus, SpendCapExceededError } from './spend-cap.js';
import { TrafficCapExceededError } from './scrapers/bandwidth.js';
import { batchScoreVideos } from '../scoring.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits } from './credits.js';
import { ingestThumbnails, type ThumbIngestTarget } from './media.js';
import { enqueueRescoreJob, enqueueThumbJob } from './jobs.js';
import { resolveRefreshPlan, type RefreshPlan } from './refresh-policy.js';
import { canonicalKey } from './canonical-query.js';
import { infoNote } from './refresh-notes.js';
import type { NormalizedVideo } from '../normalizers.js';

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

const THUMB_INGEST_MAX_PER_RUN = 15;

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
  /** bootstrap | incremental | baseline — how the limit/watermark were chosen. */
  mode?: string;
  /** Actual resultsPerPage used (after new-outlier policy). */
  limitUsed?: number;
  /** >1 when this result was produced by a multi-tenant batch scrape. */
  batchSize?: number;
  /**
   * Credits still held from the pre-auth after a failure, which the CALLER
   * must refund — but only once the job is terminally failed. A requeued job
   * keeps the debit so its retry (same idempotent `:preauth` refId) is paid
   * for. Only set when the caller passed `deferRefund`.
   */
  pendingRefundCredits?: number;
  /** Canonical key this run scraped under — for batch telemetry (§7). */
  canonicalKey?: string;
  /**
   * The dataset that produced these items. Persist it against the job: a
   * retry that hands it back re-reads the results instead of starting (and
   * paying for) a second actor run.
   */
  datasetId?: string;
  /** True when this run re-read an already-purchased dataset — cost 0. */
  resumedFromDataset?: boolean;
}

export interface RefreshExecOptions {
  /**
   * Queue callers own retry, so they own the refund: leave the pre-auth
   * debited on failure and refund it from the job's terminal branch. Direct
   * callers (scoring.ts baseline rescrape) have no retry and must refund
   * inline, which is the default.
   */
  deferRefund?: boolean;
  /**
   * A dataset this job already paid for on a previous attempt. Passed to
   * Apify instead of starting a new run — the difference between a retry
   * that costs nothing and one that buys the same page twice.
   */
  resumeDatasetId?: string;
  /**
   * Called the moment a scrape is paid for, BEFORE any persisting.
   *
   * Placement is the whole point. The failure this exists for is a worker
   * killed part-way through fan-out ("Worker did not report back; attempts
   * exhausted"): the money is gone, the data is not saved, and the retry
   * re-buys it. Handing the receipt over after the fan-out would miss exactly
   * that case. Awaited, so a receipt is durable before the risky work starts.
   */
  onScrapePaid?: (receipt: { datasetId: string; canonicalKey: string }) => Promise<void>;
}

export interface RefreshSubscriber {
  workspaceId: string;
  sourceId: string;
  /** MediaJob id when running from the queue — only for logging. */
  jobId?: string;
  opId?: string;
  preAuthCredits?: number;
  limitOverride?: number;
}

interface ApplyResult {
  newVideos: number;
  updatedVideos: number;
  skippedOld: number;
  skippedKnown: number;
  skippedBeforeWatermark: number;
  itemsConsidered: number;
  errors: string[];
  rescoreQueued: boolean;
}

/**
 * Persist/score/thumb a scrape for ONE source. Lookup of existing videos is
 * scoped to this sourceId so multi-tenant fan-out never mutates another
 * workspace's rows (a previous global platform+externalId lookup did).
 */
export async function applyScrapeItems(opts: {
  workspaceId: string;
  sourceId: string;
  items: NormalizedVideo[];
  isBaselineOnly: boolean;
  modeLabel: string;
  /** Drop items older than this after the shared scrape (per-source watermark). */
  postedAfter?: Date;
  limit: number;
  /** Apify cost attributed to the RefreshRun (leader pays full; peers 0). */
  costCents: number;
  /** Page was narrowed because the source has produced nothing new lately. */
  dry?: boolean;
  policyNote?: string;
  batchNote?: string;
}): Promise<ApplyResult> {
  const {
    workspaceId, sourceId, items, isBaselineOnly, modeLabel, postedAfter, limit, costCents,
  } = opts;

  const errors: string[] = [];
  const recencyCutoff = subMonths(new Date(), RECENCY_CUTOFF_MONTHS);
  let skippedOld = 0;
  let skippedKnown = 0;
  let skippedBeforeWatermark = 0;
  let newVideos = 0;
  let updatedVideos = 0;
  let itemsConsidered = 0;
  const thumbTargets: ThumbIngestTarget[] = [];

  // Which items survive the per-source filters, in one pass, before any DB
  // work. Fan-out multiplies every query by the number of subscribers, so the
  // existence check below is ONE findMany for the whole page rather than one
  // findFirst per item — a 10-member batch of 5 items went from 50 round-trips
  // to 10 on a pool that is only DB_CONNECTION_LIMIT (4) wide per container.
  const candidates: NormalizedVideo[] = [];
  for (const nv of items) {
    if (postedAfter && new Date(nv.postedAt) < postedAfter) {
      skippedBeforeWatermark++;
      continue;
    }
    if (new Date(nv.postedAt) < recencyCutoff) {
      skippedOld++;
      continue;
    }
    candidates.push(nv);
  }
  itemsConsidered = candidates.length;

  // SAME SOURCE only — not global. Two workspaces tracking the same TikTok
  // each need their own Video row for isolation, retention, and scoring.
  const existingRows = candidates.length > 0
    ? await db.video.findMany({
        where: { sourceId, externalId: { in: candidates.map(c => c.externalId) } },
        select: { id: true, platform: true, externalId: true },
      })
    : [];
  const existingByKey = new Map(existingRows.map(r => [`${r.platform}|${r.externalId}`, r.id]));

  for (const nv of candidates) {
    const existingId = existingByKey.get(`${nv.platform}|${nv.externalId}`);
    if (existingId) {
      await db.video.update({
        where: { id: existingId },
        data: {
          views: nv.views,
          likes: nv.likes,
          comments: nv.comments,
          shares: nv.shares,
          saves: nv.saves,
          creatorFollowers: nv.creatorFollowers,
          ...(isBaselineOnly ? {} : { isBaselineSample: false }),
        } as any,
      });
      updatedVideos++;
      skippedKnown++;
      continue;
    }

    let created: { id: string };
    try {
      created = await db.video.create({
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
        } as any,
        select: { id: true },
      });
    } catch (err) {
      // Unique violation on (sourceId, platform, externalId): another worker
      // applied the same shared scrape to this source between our read and our
      // write. That is a normal race now that two worker containers can drain
      // refresh, and the row it lost to is the row we wanted — treat it as an
      // update, never as a failure. Without the index this was a silent
      // duplicate instead.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const raced = await db.video.findFirst({
        where: { sourceId, platform: nv.platform, externalId: nv.externalId },
        select: { id: true },
      });
      if (!raced) throw err;
      await db.video.update({
        where: { id: raced.id },
        data: {
          views: nv.views,
          likes: nv.likes,
          comments: nv.comments,
          shares: nv.shares,
          saves: nv.saves,
          creatorFollowers: nv.creatorFollowers,
          ...(isBaselineOnly ? {} : { isBaselineSample: false }),
        } as any,
      });
      updatedVideos++;
      skippedKnown++;
      continue;
    }

    newVideos++;
    if (!isBaselineOnly) {
      thumbTargets.push({
        videoId: created.id,
        platform: nv.platform,
        thumbnailUrl: nv.thumbnailUrl,
        coverDownloadUrl: nv.coverDownloadUrl,
      });
    }
  }

  // policyNote carries Apify's own notices (a failed record, an unusable
  // result) — those are real, leave them untagged. Everything below is
  // bookkeeping: still written to RefreshRun.errorsJson for support, tagged
  // with INFO_PREFIX so the UI never renders it as a refresh warning.
  if (opts.policyNote) errors.push(opts.policyNote);
  if (opts.batchNote) errors.push(infoNote(opts.batchNote));
  if (!isBaselineOnly) {
    errors.push(infoNote(
      `Refresh policy: mode=${modeLabel} limit=${limit}`
      + (postedAfter ? ` postedAfter=${postedAfter.toISOString()}` : '')
      + (opts.dry ? ` (dry source — narrowed page)` : ''),
    ));
  }
  if (skippedOld > 0) {
    errors.push(infoNote(
      `Recency filter: ${skippedOld} of ${items.length} scraped videos were older than `
      + `${RECENCY_CUTOFF_MONTHS} months and were not saved`,
    ));
  }
  if (skippedBeforeWatermark > 0) {
    errors.push(infoNote(
      `Per-source watermark: ${skippedBeforeWatermark} items older than this source's `
      + `postedAfter were ignored after a widened batch scrape`,
    ));
  }
  if (skippedKnown > 0 && modeLabel === 'incremental') {
    errors.push(infoNote(
      `Already known: ${skippedKnown}/${itemsConsidered || items.length} results were existing videos `
      + `(stats updated; not new outliers)`,
    ));
  }

  if (newVideos > 0 || updatedVideos > 0) {
    await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
  }

  if (thumbTargets.length > 0) {
    const batch = thumbTargets.slice(0, THUMB_INGEST_MAX_PER_RUN);
    const overflow = thumbTargets.slice(THUMB_INGEST_MAX_PER_RUN);
    const ingest = await ingestThumbnails(workspaceId, batch);
    if (ingest.failed > 0) {
      errors.push(`Thumbnail ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
    }
    // Queue the overflow instead of dropping it. Each deferred cover becomes a
    // cheap `thumb` job (see src/lib/jobs.ts enqueueThumbJob) that a worker
    // drains shortly after — inside the source CDN URL's lifetime. Before this,
    // these stayed thumbStatus 'none' forever and the gallery fell back to the
    // expiring TikTok CDN URL. No Apify/AI spend, so no credits or opId.
    let enqueued = 0;
    for (const t of overflow) {
      try {
        await enqueueThumbJob({
          workspaceId,
          videoId: t.videoId,
          payload: { thumbnailUrl: t.thumbnailUrl, coverDownloadUrl: t.coverDownloadUrl ?? null },
        });
        enqueued++;
      } catch (err) {
        errors.push(`Thumb enqueue failed for ${t.videoId.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    if (overflow.length > 0) {
      errors.push(infoNote(
        `Thumbnail ingest: ${overflow.length} beyond the per-run cap of ${THUMB_INGEST_MAX_PER_RUN} `
        + `queued as thumb jobs (${enqueued} enqueued)`,
      ));
    }
  }

  await db.refreshRun.create({
    data: {
      sourceId,
      itemsPulled: items.length,
      newVideos,
      errorsJson: JSON.stringify(errors),
      costCents,
      ranAt: new Date(),
    },
  });
  await db.source.update({ where: { id: sourceId }, data: { lastRefreshedAt: new Date() } });

  let rescoreQueued = false;
  // Caller decides creator rescore (needs effectiveSourceType/query).

  return {
    newVideos,
    updatedVideos,
    skippedOld,
    skippedKnown,
    skippedBeforeWatermark,
    itemsConsidered,
    errors,
    rescoreQueued,
  };
}

async function settleAndApply(opts: {
  workspaceId: string;
  sourceId: string;
  platform: string;
  sourceType: string;
  query: string;
  isBaselineOnly: boolean;
  modeLabel: string;
  planPostedAfter?: Date;
  planDry?: boolean;
  limit: number;
  items: NormalizedVideo[];
  scrapeCostCents: number;
  /** Apify cents attributed to THIS source's RefreshRun (pro-rata in a batch). */
  attributedCostCents: number;
  opId: string;
  preAuthCredits: number;
  creditBalanceTotal: number;
  policyReason?: string;
  batchNote?: string;
  canonicalKey?: string;
  deferRefund?: boolean;
  startTime: number;
}): Promise<RunRefreshResult> {
  const base = {
    sourceId: opts.sourceId,
    query: opts.query,
    platform: opts.platform,
    sourceType: opts.sourceType,
  };

  // Charge credits for items that mattered to THIS source, not for peers'
  // watermarks. Floor at 0 when the scrape returned nothing usable so we
  // refund the full pre-auth.
  let apply: ApplyResult;
  try {
    apply = await applyScrapeItems({
      workspaceId: opts.workspaceId,
      sourceId: opts.sourceId,
      items: opts.items,
      isBaselineOnly: opts.isBaselineOnly,
      modeLabel: opts.modeLabel,
      postedAfter: opts.isBaselineOnly ? undefined : opts.planPostedAfter,
      limit: opts.limit,
      costCents: opts.attributedCostCents,
      dry: opts.planDry,
      policyNote: opts.policyReason,
      batchNote: opts.batchNote,
    });
  } catch (err) {
    // Persist failed. Whether the pre-auth comes back depends on whether this
    // attempt was the LAST one: a requeued job keeps its debit so the retry
    // (which replays the same idempotent `:preauth` refId and therefore
    // charges nothing) is still paid for. Refunding here and requeueing made
    // every retry free — see G4 in docs/apify-multi-tenant-batching-plan.md.
    if (!opts.deferRefund) {
      const creditBalance = await refundCredits(
        opts.workspaceId, opts.preAuthCredits, 'refresh_source', `${opts.opId}:fail`, 'call_failed',
      );
      return {
        ok: false, ...base,
        itemsPulled: opts.items.length, newVideos: 0, costCents: 0,
        creditsCharged: 0, creditsRemaining: creditBalance.total,
        errors: [(err as Error).message], rescoreQueued: false,
        durationMs: Date.now() - opts.startTime,
        mode: opts.modeLabel, limitUsed: opts.limit,
      };
    }
    return {
      ok: false, ...base,
      itemsPulled: opts.items.length, newVideos: 0, costCents: 0,
      creditsCharged: 0, creditsRemaining: opts.creditBalanceTotal,
      pendingRefundCredits: opts.preAuthCredits,
      errors: [(err as Error).message], rescoreQueued: false,
      durationMs: Date.now() - opts.startTime,
      mode: opts.modeLabel, limitUsed: opts.limit,
    };
  }

  // Bill NEW videos only. Charging for `updatedVideos` too meant a workspace
  // that already held all five results paid full price for a stats refresh —
  // exactly the waste multi-tenant batching exists to remove (§4, G9).
  const billable = apply.newVideos;
  const actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * billable);
  const refundAmount = opts.preAuthCredits - actualCredits;
  let creditsRemaining = opts.creditBalanceTotal;
  if (refundAmount > 0) {
    const bal = await refundCredits(
      opts.workspaceId, refundAmount, 'refresh_source', `${opts.opId}:settle`, 'usage_settlement',
    );
    creditsRemaining = bal.total;
  } else if (actualCredits > opts.preAuthCredits) {
    // Pre-auth was smaller than billable (should not happen if plan aligned).
    // Debit the delta under a settle ref rather than under-billing.
    try {
      const bal = await debitCredits(
        opts.workspaceId,
        actualCredits - opts.preAuthCredits,
        'refresh_source',
        `${opts.opId}:topup`,
      );
      creditsRemaining = bal.total;
    } catch {
      // Best-effort; pre-auth already covered the planned worst case.
    }
  }

  let rescoreQueued = false;
  if (opts.sourceType === 'creator' && opts.items.length > 0 && !opts.isBaselineOnly) {
    try {
      await enqueueRescoreJob({
        workspaceId: opts.workspaceId,
        sourceId: opts.sourceId,
        payload: { creatorHandle: opts.query },
      });
      rescoreQueued = true;
    } catch (err) {
      apply.errors.push(`could not queue rescore: ${(err as Error).message}`);
    }
  }

  return {
    ok: true, ...base,
    itemsPulled: opts.items.length,
    newVideos: apply.newVideos,
    costCents: opts.attributedCostCents,
    creditsCharged: actualCredits,
    creditsRemaining,
    errors: apply.errors,
    rescoreQueued,
    durationMs: Date.now() - opts.startTime,
    mode: opts.modeLabel,
    limitUsed: opts.limit,
    canonicalKey: opts.canonicalKey,
  };
}

/**
 * Pre-authorise, scrape, persist, score, settle for a single source.
 * Used by baseline rescrapes and any non-batched path. Queue path prefers
 * runBatchedRefresh so multi-tenant peers share one Apify call.
 */
export async function runRefresh(opts: {
  workspaceId: string;
  sourceId: string;
  limitOverride?: number;
  opId?: string;
  preAuthCredits?: number;
  sourceTypeOverride?: 'creator' | 'keyword' | 'hashtag';
  queryOverride?: string;
  deferRefund?: boolean;
}): Promise<RunRefreshResult> {
  // Baseline overrides cannot join a tenant batch (different query shape).
  if (opts.sourceTypeOverride || opts.queryOverride) {
    return runRefreshSolo(opts);
  }
  const results = await runBatchedRefresh([{
    workspaceId: opts.workspaceId,
    sourceId: opts.sourceId,
    opId: opts.opId,
    preAuthCredits: opts.preAuthCredits,
    limitOverride: opts.limitOverride,
  }], { deferRefund: opts.deferRefund });
  return results[0]!;
}

async function runRefreshSolo(opts: {
  workspaceId: string;
  sourceId: string;
  limitOverride?: number;
  opId?: string;
  preAuthCredits?: number;
  sourceTypeOverride?: 'creator' | 'keyword' | 'hashtag';
  queryOverride?: string;
  deferRefund?: boolean;
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
  const isBaselineOnly = !!opts.sourceTypeOverride;
  const limit = limitOverride ?? source.videoLimit;
  const modeLabel = isBaselineOnly ? 'baseline' : 'solo';
  const base = {
    sourceId, query: effectiveQuery, platform: source.platform, sourceType: effectiveSourceType,
  };

  if (scrapeCapKind(source.platform) === 'proxy') {
    const capStatus = await trafficStatus(workspaceId);
    if (capStatus.breached) {
      return {
        ok: false, refusal: 'cap_breached', refusalDetail: capStatus, ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
        errors: ['Proxy traffic cap already breached'], rescoreQueued: false,
        durationMs: Date.now() - startTime, mode: modeLabel, limitUsed: limit,
      };
    }
  } else if (source.platform !== 'shorts') {
    const capStatus = await getApifyCapStatus(workspaceId);
    if (capStatus.breached) {
      return {
        ok: false, refusal: 'cap_breached', refusalDetail: capStatus, ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
        errors: ['Apify spend cap already breached'], rescoreQueued: false,
        durationMs: Date.now() - startTime, mode: modeLabel, limitUsed: limit,
      };
    }
  }

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
        mode: modeLabel, limitUsed: limit,
      };
    }
    throw err;
  }

  let items: NormalizedVideo[] = [];
  let costCents = 0;
  const errors: string[] = [];

  try {
    const result = await scrapeSource({
      workspaceId,
      platform: source.platform,
      sourceType: effectiveSourceType,
      query: effectiveQuery,
      limit,
      refId: sourceId,
    });
    items = result.items;
    costCents = result.costCents;
    if (result.notices.length > 0) errors.push(...result.notices);
  } catch (err) {
    // Deferred refund (queue caller): keep the debit so a retry is still paid
    // for; the caller refunds from the terminal branch. See G4.
    const settleFailure = async () => {
      if (opts.deferRefund) return { total: creditBalance!.total, pending: preAuthCredits };
      const bal = await refundCredits(
        workspaceId, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed',
      );
      return { total: bal.total, pending: undefined as number | undefined };
    };
    if (err instanceof SpendCapExceededError || err instanceof TrafficCapExceededError) {
      const settledFail = await settleFailure();
      return {
        ok: false, refusal: 'cap_breached',
        refusalDetail: await getApifyCapStatus(workspaceId), ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
        creditsRemaining: settledFail.total,
        pendingRefundCredits: settledFail.pending,
        errors: [err.message], rescoreQueued: false, durationMs: Date.now() - startTime,
        mode: modeLabel, limitUsed: limit,
      };
    }
    const settledFail = await settleFailure();
    return {
      ok: false, ...base,
      itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
      creditsRemaining: settledFail.total,
      pendingRefundCredits: settledFail.pending,
      errors: [(err as Error).message], rescoreQueued: false,
      durationMs: Date.now() - startTime, mode: modeLabel, limitUsed: limit,
    };
  }

  const settled = await settleAndApply({
    workspaceId,
    sourceId,
    platform: source.platform,
    sourceType: effectiveSourceType,
    query: effectiveQuery,
    isBaselineOnly,
    modeLabel,
    limit,
    items,
    scrapeCostCents: costCents,
    attributedCostCents: costCents,
    opId,
    preAuthCredits,
    creditBalanceTotal: creditBalance.total,
    policyReason: errors.length ? errors.join(' | ') : undefined,
    deferRefund: opts.deferRefund,
    startTime,
  });
  return settled;
}

/**
 * One Apify scrape for many (workspace, source) pairs that share a canonical
 * query. Each member is debited/settled independently; a broke tenant is
 * refused without aborting the batch.
 */
export async function runBatchedRefresh(
  members: RefreshSubscriber[],
  exec?: RefreshExecOptions,
): Promise<RunRefreshResult[]> {
  if (members.length === 0) return [];
  const startTime = Date.now();

  type Ready = {
    member: RefreshSubscriber;
    source: {
      id: string;
      workspaceId: string;
      platform: string;
      sourceType: string;
      query: string;
      videoLimit: number;
      lastRefreshedAt: Date | null;
    };
    plan: RefreshPlan;
    opId: string;
    preAuthCredits: number;
    creditBalanceTotal: number;
  };

  const ready: Ready[] = [];
  const early: RunRefreshResult[] = [];

  for (const member of members) {
    const source = await db.source.findFirst({
      where: { id: member.sourceId, workspaceId: member.workspaceId },
    });
    if (!source) {
      early.push({
        ok: false, refusal: 'source_not_found', sourceId: member.sourceId,
        query: '', platform: '', sourceType: '',
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
        errors: ['Source not found'], rescoreQueued: false,
        durationMs: Date.now() - startTime,
      });
      continue;
    }

    if (scrapeCapKind(source.platform) === 'proxy') {
      const capStatus = await trafficStatus(member.workspaceId);
      if (capStatus.breached) {
        early.push({
          ok: false, refusal: 'cap_breached', refusalDetail: capStatus,
          sourceId: source.id, query: source.query, platform: source.platform,
          sourceType: source.sourceType,
          itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
          errors: ['Proxy traffic cap already breached'], rescoreQueued: false,
          durationMs: Date.now() - startTime,
        });
        continue;
      }
    } else if (source.platform !== 'shorts') {
      const capStatus = await getApifyCapStatus(member.workspaceId);
      if (capStatus.breached) {
        early.push({
          ok: false, refusal: 'cap_breached', refusalDetail: capStatus,
          sourceId: source.id, query: source.query, platform: source.platform,
          sourceType: source.sourceType,
          itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
          errors: ['Apify spend cap already breached'], rescoreQueued: false,
          durationMs: Date.now() - startTime,
        });
        continue;
      }
    }

    const plan = await resolveRefreshPlan(
      {
        id: source.id,
        sourceType: source.sourceType,
        videoLimit: source.videoLimit,
        lastRefreshedAt: source.lastRefreshedAt,
      },
      member.limitOverride,
    );

    const opId = member.opId ?? randomUUID();
    const preAuthCredits = member.preAuthCredits
      ?? Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * plan.limit);

    try {
      const creditBalance = await debitCredits(
        member.workspaceId, preAuthCredits, 'refresh_source', `${opId}:preauth`,
      );
      ready.push({
        member,
        source: {
          id: source.id,
          workspaceId: source.workspaceId,
          platform: source.platform,
          sourceType: source.sourceType,
          query: source.query,
          videoLimit: source.videoLimit,
          lastRefreshedAt: source.lastRefreshedAt,
        },
        plan,
        opId,
        preAuthCredits,
        creditBalanceTotal: creditBalance.total,
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        early.push({
          ok: false, refusal: 'insufficient_credits',
          refusalDetail: { required: preAuthCredits, message: err.message },
          sourceId: source.id, query: source.query, platform: source.platform,
          sourceType: source.sourceType,
          itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0, creditsRemaining: 0,
          errors: [err.message], rescoreQueued: false,
          durationMs: Date.now() - startTime,
          mode: plan.mode, limitUsed: plan.limit,
        });
        continue;
      }
      throw err;
    }
  }

  if (ready.length === 0) return early;

  // Merge plans: widest page, widest date window (oldest watermark / none).
  const limit = Math.max(...ready.map(r => r.plan.limit));
  const withWatermark = ready.filter(r => r.plan.postedAfter);
  const anyBootstrap = ready.some(r => r.plan.mode === 'bootstrap');
  let postedAfter: Date | undefined;
  if (!anyBootstrap && withWatermark.length === ready.length) {
    postedAfter = withWatermark
      .map(r => r.plan.postedAfter!)
      .reduce((a, b) => (a < b ? a : b));
  }

  const leader = ready[0]!;
  const platform = leader.source.platform;
  const sourceType = leader.source.sourceType as 'creator' | 'keyword' | 'hashtag';
  const query = leader.source.query;
  const key = canonicalKey(platform, sourceType, query);

  // A shared scrape is a shared purchase: the cap check and the recorded
  // Apify spend are split pro-rata across everyone in the batch (see
  // splitSpend in apify.ts). Charging the whole run to `ready[0]` let one
  // arbitrary tenant's cap pay for nine others and breach on their behalf,
  // aborting the batch (G1/G3). No platform/system workspace is needed —
  // the cost genuinely belongs to these tenants, in Nths.
  const costShareWorkspaceIds = ready.map(r => r.member.workspaceId);

  let scrape: ScrapeResult;
  try {
    scrape = await scrapeSource({
      workspaceId: leader.member.workspaceId,
      costShareWorkspaceIds,
      platform,
      sourceType,
      query,
      limit,
      postedAfter,
      // Canonical key, not a sourceId: in a batch this ONE charge belongs to
      // every member. Attributing it to the leader's source would overstate
      // that source and zero out its peers.
      refId: key,
      resumeDatasetId: exec?.resumeDatasetId,
    });
  } catch (err) {
    // Scrape never landed. Nobody is charged for it, but the pre-auth only
    // comes back when the caller says this attempt was the last one (G4).
    const failed: RunRefreshResult[] = [];
    for (const r of ready) {
      let creditsRemaining = r.creditBalanceTotal;
      let pending: number | undefined;
      if (exec?.deferRefund) {
        pending = r.preAuthCredits;
      } else {
        const bal = await refundCredits(
          r.member.workspaceId, r.preAuthCredits, 'refresh_source', `${r.opId}:fail`, 'call_failed',
        );
        creditsRemaining = bal.total;
      }
      failed.push({
        ok: false,
        refusal: err instanceof SpendCapExceededError || err instanceof TrafficCapExceededError
          ? 'cap_breached' : undefined,
        refusalDetail: err instanceof SpendCapExceededError
          ? await getApifyCapStatus(r.member.workspaceId)
          : err instanceof TrafficCapExceededError
            ? await trafficStatus(r.member.workspaceId)
            : undefined,
        sourceId: r.source.id,
        query: r.source.query,
        platform: r.source.platform,
        sourceType: r.source.sourceType,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
        creditsRemaining,
        pendingRefundCredits: pending,
        errors: [(err as Error).message],
        rescoreQueued: false,
        durationMs: Date.now() - startTime,
        mode: r.plan.mode,
        limitUsed: limit,
        batchSize: ready.length,
        canonicalKey: key,
      });
    }
    return [...early, ...failed];
  }

  // The scrape is paid for and the dataset exists. Persist the receipt now,
  // before persisting/scoring/thumbnailing any of it — everything below this
  // line can die and take the results with it, and the retry must be able to
  // pick the dataset back up instead of buying it again. Never for a resumed
  // run: re-stamping the receipt would keep a stale dataset alive forever.
  if (exec?.onScrapePaid && scrape.datasetId && !scrape.resumed) {
    await exec.onScrapePaid({ datasetId: scrape.datasetId, canonicalKey: key })
      .catch(err => console.warn(`[refresh] scrape receipt not saved: ${(err as Error).message}`));
  }

  // Pro-rata, integer cents, remainder to the leader — so per-source cost
  // analytics stay meaningful instead of one row holding the whole batch and
  // N-1 rows holding zero (G2).
  const share = Math.floor(scrape.costCents / ready.length);
  const remainder = scrape.costCents - share * ready.length;

  const notes: string[] = [];
  if (ready.length > 1) {
    notes.push(
      `Multi-tenant batch: ${ready.length} sources shared one Apify scrape `
      + `(canonical ${key}); Apify cost ${scrape.costCents}c split pro-rata `
      + `across ${new Set(costShareWorkspaceIds).size} workspace(s)`,
    );
  }
  if (scrape.resumed) {
    // Visible in RefreshRun.errorsJson so a 0c run reads as "already paid for"
    // rather than looking like a refresh that mysteriously cost nothing.
    notes.push(
      `Resumed dataset ${scrape.datasetId} from a previous attempt — no new Apify run, 0c`,
    );
  }
  const batchNote = notes.length ? notes.join(' | ') : undefined;

  const applied: RunRefreshResult[] = [];
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i]!;
    const attributedCostCents = share + (i === 0 ? remainder : 0);

    // No extra UsageLog row here: scrapeSource already wrote one real
    // `scrape` row per sharing workspace for its pro-rata share, so each
    // workspace's cap and COGS reporting see exactly what it consumed.

    const result = await settleAndApply({
      workspaceId: r.member.workspaceId,
      sourceId: r.source.id,
      platform: r.source.platform,
      sourceType: r.source.sourceType,
      query: r.source.query,
      isBaselineOnly: false,
      modeLabel: r.plan.mode,
      planPostedAfter: r.plan.postedAfter,
      planDry: r.plan.dry,
      limit: r.plan.limit,
      items: scrape.items,
      scrapeCostCents: scrape.costCents,
      attributedCostCents,
      opId: r.opId,
      preAuthCredits: r.preAuthCredits,
      creditBalanceTotal: r.creditBalanceTotal,
      policyReason: scrape.notices.length ? scrape.notices.join(' | ') : undefined,
      batchNote,
      canonicalKey: key,
      deferRefund: exec?.deferRefund,
      startTime,
    });
    result.batchSize = ready.length;
    result.datasetId = scrape.datasetId ?? undefined;
    result.resumedFromDataset = scrape.resumed;
    if (scrape.notices.length && !result.errors.some(e => scrape.notices.includes(e))) {
      result.errors = [...scrape.notices, ...result.errors];
    }
    applied.push(result);
  }

  return [...early, ...applied];
}
