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
import { scrapeSource, type ApifyScrapeResult } from './apify.js';
import { getApifyCapStatus, SpendCapExceededError } from './spend-cap.js';
import { batchScoreVideos } from '../scoring.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits } from './credits.js';
import { ingestThumbnails, type ThumbIngestTarget } from './media.js';
import { enqueueRescoreJob } from './jobs.js';
import { resolveRefreshPlan, type RefreshPlan } from './refresh-policy.js';
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

  for (const nv of items) {
    if (postedAfter && new Date(nv.postedAt) < postedAfter) {
      skippedBeforeWatermark++;
      continue;
    }
    if (new Date(nv.postedAt) < recencyCutoff) {
      skippedOld++;
      continue;
    }
    itemsConsidered++;

    // SAME SOURCE only — not global. Two workspaces tracking the same TikTok
    // each need their own Video row for isolation, retention, and scoring.
    const existing = await db.video.findFirst({
      where: { platform: nv.platform, externalId: nv.externalId, sourceId },
      select: { id: true },
    });
    if (existing) {
      await db.video.update({
        where: { id: existing.id },
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
      } as any,
      select: { id: true },
    });
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

  if (opts.policyNote) errors.push(opts.policyNote);
  if (opts.batchNote) errors.push(opts.batchNote);
  if (!isBaselineOnly) {
    errors.push(
      `Refresh policy: mode=${modeLabel} limit=${limit}`
      + (postedAfter ? ` postedAfter=${postedAfter.toISOString()}` : ''),
    );
  }
  if (skippedOld > 0) {
    errors.push(
      `Recency filter: ${skippedOld} of ${items.length} scraped videos were older than `
      + `${RECENCY_CUTOFF_MONTHS} months and were not saved (cosmetic only)`,
    );
  }
  if (skippedBeforeWatermark > 0) {
    errors.push(
      `Per-source watermark: ${skippedBeforeWatermark} items older than this source's `
      + `postedAfter were ignored after a widened batch scrape`,
    );
  }
  if (skippedKnown > 0 && modeLabel === 'incremental') {
    errors.push(
      `Already known: ${skippedKnown}/${itemsConsidered || items.length} results were existing videos `
      + `(stats updated; not new outliers)`,
    );
  }

  if (newVideos > 0 || updatedVideos > 0) {
    await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
  }

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
  limit: number;
  items: NormalizedVideo[];
  scrapeCostCents: number;
  /** Only the batch leader records Apify cost on RefreshRun. */
  attributeApifyCost: boolean;
  opId: string;
  preAuthCredits: number;
  creditBalanceTotal: number;
  policyReason?: string;
  batchNote?: string;
  startTime: number;
}): Promise<RunRefreshResult> {
  const base = {
    sourceId: opts.sourceId,
    query: opts.query,
    platform: opts.platform,
    sourceType: opts.sourceType,
  };

  // Charge credits for items that mattered to THIS source (new or updated),
  // not for peers' watermarks. Floor at 0 when the scrape returned nothing
  // usable so we refund the full pre-auth.
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
      costCents: opts.attributeApifyCost ? opts.scrapeCostCents : 0,
      policyNote: opts.policyReason,
      batchNote: opts.batchNote,
    });
  } catch (err) {
    // Persist failed — still settle credits for what Apify returned so we do
    // not keep a full pre-auth locked. Refund everything; surface the error.
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

  const billable = apply.newVideos + apply.updatedVideos;
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
    costCents: opts.attributeApifyCost ? opts.scrapeCostCents : 0,
    creditsCharged: actualCredits,
    creditsRemaining,
    errors: apply.errors,
    rescoreQueued,
    durationMs: Date.now() - opts.startTime,
    mode: opts.modeLabel,
    limitUsed: opts.limit,
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
  }]);
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

  if (source.platform !== 'shorts') {
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
    });
    items = result.items;
    costCents = result.costCents;
    if (result.notices.length > 0) errors.push(...result.notices);
  } catch (err) {
    if (err instanceof SpendCapExceededError) {
      creditBalance = await refundCredits(workspaceId, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed');
      return {
        ok: false, refusal: 'cap_breached',
        refusalDetail: await getApifyCapStatus(workspaceId), ...base,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
        creditsRemaining: creditBalance.total,
        errors: [err.message], rescoreQueued: false, durationMs: Date.now() - startTime,
        mode: modeLabel, limitUsed: limit,
      };
    }
    const bal = await refundCredits(workspaceId, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed');
    return {
      ok: false, ...base,
      itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
      creditsRemaining: bal.total,
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
    attributeApifyCost: true,
    opId,
    preAuthCredits,
    creditBalanceTotal: creditBalance.total,
    policyReason: errors.length ? errors.join(' | ') : undefined,
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

    if (source.platform !== 'shorts') {
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

  let scrape: ApifyScrapeResult;
  try {
    scrape = await scrapeSource({
      workspaceId: leader.member.workspaceId,
      platform,
      sourceType,
      query,
      limit,
      postedAfter,
    });
  } catch (err) {
    // Refund every ready member — scrape never landed.
    const failed: RunRefreshResult[] = [];
    for (const r of ready) {
      const bal = await refundCredits(
        r.member.workspaceId, r.preAuthCredits, 'refresh_source', `${r.opId}:fail`, 'call_failed',
      );
      failed.push({
        ok: false,
        refusal: err instanceof SpendCapExceededError ? 'cap_breached' : undefined,
        refusalDetail: err instanceof SpendCapExceededError
          ? await getApifyCapStatus(r.member.workspaceId)
          : undefined,
        sourceId: r.source.id,
        query: r.source.query,
        platform: r.source.platform,
        sourceType: r.source.sourceType,
        itemsPulled: 0, newVideos: 0, costCents: 0, creditsCharged: 0,
        creditsRemaining: bal.total,
        errors: [(err as Error).message],
        rescoreQueued: false,
        durationMs: Date.now() - startTime,
        mode: r.plan.mode,
        limitUsed: limit,
        batchSize: ready.length,
      });
    }
    return [...early, ...failed];
  }

  const batchNote = ready.length > 1
    ? `Multi-tenant batch: ${ready.length} sources shared one Apify scrape `
      + `(canonical ${platform}/${sourceType}/${query}); Apify cost attributed to leader only`
    : undefined;

  const applied: RunRefreshResult[] = [];
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i]!;
    const result = await settleAndApply({
      workspaceId: r.member.workspaceId,
      sourceId: r.source.id,
      platform: r.source.platform,
      sourceType: r.source.sourceType,
      query: r.source.query,
      isBaselineOnly: false,
      modeLabel: r.plan.mode,
      planPostedAfter: r.plan.postedAfter,
      limit: r.plan.limit,
      items: scrape.items,
      scrapeCostCents: scrape.costCents,
      attributeApifyCost: i === 0,
      opId: r.opId,
      preAuthCredits: r.preAuthCredits,
      creditBalanceTotal: r.creditBalanceTotal,
      policyReason: scrape.notices.length ? scrape.notices.join(' | ') : undefined,
      batchNote,
      startTime,
    });
    result.batchSize = ready.length;
    if (scrape.notices.length && !result.errors.some(e => scrape.notices.includes(e))) {
      result.errors = [...scrape.notices, ...result.errors];
    }
    applied.push(result);
  }

  return [...early, ...applied];
}
