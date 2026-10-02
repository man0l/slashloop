// ---------------------------------------------------------------------------
// MediaJob queue — work that cannot finish inside one request.
//
// See docs/media-storage-plan.md §3.3. The constraint this exists for:
// api/mcp.ts has maxDuration 60, the Vercel plan cannot raise it, and a
// gemini-native analysis (Apify download -> Gemini upload -> processing wait ->
// generate) does not fit. Worse, the MCP client applies its own timeout, so
// even a raised server ceiling would not save a synchronous call.
//
// So analyze_video records intent and returns a job id; a separate invocation
// does the work with a fresh budget of its own.
//
// This module owns the state machine only. The worker lives in
// src/worker/index.ts (VPS drainer, WORKER_KINDS-selected containers); the
// Cloudflare Worker only steps video-mode recreates via the */2 cron
// (src/cf/video-recreate-cron.ts).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chunked, coerceRowDates, dbDialect, rawBatch, type RawStatement } from '../store.js';
import { ProducerHttpError, loadProducerConfig, publishJobHttp } from '../queue/producer.js';
import { QueuePublisher } from '../queue/publisher.js';
import { QUEUE_FALLBACK_STATUS, getQueueFallbackEnabled } from '../queue/transport.js';
import { CREDIT_COSTS, refundCredits, refundCreditsBatched, type RefundItem } from './credits.js';
import { classifyFetchError } from './fetch-errors.js';
import { notifyScrapeFailure, markScrapeSuccess } from './scrape-alert.js';
import { createThrottle, foldedSuffix } from './log-throttle.js';

// ---------------------------------------------------------------------------
// Routed enqueue (SLA-16 Phase 2b): every enqueue*Job below funnels through
// enqueueRouted, which publishes via QueuePublisher. Transport resolves per
// kind (queue.transport.<kind>, QUEUE_BACKEND default); while every kind is
// D1-owned the write is byte-identical to the legacy direct create.
// Business validation lives in the callers and is unchanged here.
// ---------------------------------------------------------------------------

let routedPublisher: QueuePublisher | null = null;
let routedPublisherKey = '';

function routedQueuePublisher(): QueuePublisher {
  const cfg = loadProducerConfig();
  const envFb = (process.env.QUEUE_FALLBACK_ENABLED ?? '').trim();
  const fallbackEnabled = envFb === '1' ? true : envFb === '0' ? false : undefined;
  const key = cfg
    ? `${cfg.baseUrl}|${cfg.keyId}|${cfg.timeoutMs}|fb:${envFb || 'ctrl'}`
    : `d1|fb:${envFb || 'ctrl'}`;
  if (!routedPublisher || routedPublisherKey !== key) {
    routedPublisher = new QueuePublisher({
      d1: {
        createOwnedJob: async (input) => {
          const row = (await db.mediaJob.create({
            data: {
              ...(input.id ? { id: input.id } : {}),
              workspaceId: input.workspaceId,
              videoId: input.videoId,
              sourceId: input.sourceId,
              kind: input.kind,
              status: input.status ?? 'queued',
              payloadJson: input.payloadJson,
              deadlineAt: input.deadlineAt,
              opId: input.opId,
              preAuthCredits: input.preAuthCredits,
              analysisId: input.analysisId,
              queueOwner: input.queueOwner,
            },
          })) as unknown as MediaJobRow;
          return { id: row.id };
        },
        markD1ProjectionPg: async (d1JobId) => {
          // Fallback promotion only. Fresh PG publishes insert queueOwner='pg'
          // themselves; this UPDATE is how a fallback_d1 / queued_remote row
          // becomes the claimable-by-nobody projection pollers already read.
          // The PG row shares this id (d1_job_id), so there is no second key.
          await db.mediaJob.update({
            where: { id: d1JobId },
            data: { queueOwner: 'pg', status: 'queued' },
          });
        },
      },
      pg: cfg
        ? {
            publish: async (input) => publishJobHttp(cfg, { ...input, payload: input.payload }),
          }
        : undefined,
      fallbackEnabled,
      resolveFallbackEnabled: getQueueFallbackEnabled,
    });
    routedPublisherKey = key;
  }
  return routedPublisher;
}

/** Test seam — drop the cached publisher (env/secret rotation in tests). */
export function resetRoutedPublisherForTests(): void {
  routedPublisher = null;
  routedPublisherKey = '';
}

/**
 * Single choke point for all enqueues. Returns the D1 row (legacy row on the
 * D1 transport, compatibility projection on the PG transport) in MediaJobRow
 * shape, plus the transport's dedupe bit. opId/preAuthCredits arrive
 * pre-minted from the caller and pass through verbatim — never re-minted here.
 *
 * `deduped` is load-bearing, not decoration (SLA-329): on the PG transport a
 * publish that resolves to an existing key creates NO new work, and for four
 * days rescoreStaleTooFresh counted exactly that as a queued creator scrape —
 * so a permanently-deduping key was invisible from every log. Callers that
 * report "queued" must check it; the row's `status` says which row they got.
 */
async function enqueueRouted(opts: {
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  payload: unknown;
  opId: string | null;
  preAuthCredits: number | null;
  deadlineAt?: Date | null;
  dedupeKey?: string | null;
  analysisId?: string | null;
}): Promise<EnqueuedJob> {
  const ref = await routedQueuePublisher().publish({
    kind: opts.kind,
    workspaceId: opts.workspaceId,
    videoId: opts.videoId,
    sourceId: opts.sourceId,
    payload: opts.payload,
    opId: opts.opId,
    preAuthCredits: opts.preAuthCredits,
    deadlineAt: opts.deadlineAt ?? null,
    dedupeKey: opts.dedupeKey ?? null,
    analysisId: opts.analysisId ?? null,
  });
  const row = await db.mediaJob.findUnique({ where: { id: ref.d1JobId } });
  if (!row) throw new Error(`queue publisher lost D1 row ${ref.d1JobId}`);
  // On PG dedupe, ref.d1JobId is the original shared id (no second projection).
  return { ...(row as unknown as MediaJobRow), deduped: ref.deduped };
}

/** Raw-row date columns, hydrated to Date on SQLite (raw SQL returns strings there). */
const MEDIA_JOB_DATE_KEYS = ['deadlineAt', 'createdAt', 'startedAt', 'finishedAt', 'availableAt'] as const;

/** Exported for the recreate-video stepper's raw claim (same shape needs). */
export function toMediaJobRow(row: Record<string, unknown>): MediaJobRow {
  return coerceRowDates(row, MEDIA_JOB_DATE_KEYS) as unknown as MediaJobRow;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'queued_remote';

/**
 * Give up after this many attempts.
 *
 * Each attempt costs an Apify download, so an unbounded retry on a video that
 * simply cannot be fetched would quietly burn the spend cap.
 */
export const MAX_ATTEMPTS = 3;

/**
 * A `running` row older than this is presumed abandoned.
 *
 * The worker's invocation can die without unwinding — the 60s ceiling, an OOM,
 * or a dispatch that was cancelled after the row was already claimed. Nothing
 * would ever move that row again, so the sweeper returns it to `queued`. The
 * threshold only has to exceed the longest a live worker could hold a claim,
 * which is bounded by its own maxDuration.
 */
export const STUCK_AFTER_MINUTES = 15;

/**
 * Wall-clock cap for one claimed job in the VPS worker. reclaimStuckJobs is
 * a 15-minute last resort for a killed process; this is what stops a hung
 * TikTok fetch from blocking the other slot in WORKER_CONCURRENCY forever.
 *
 * Analyze is bounded by OPENROUTER_VIDEO_TIMEOUT_MS (300s in prod) plus slack.
 * Refresh/discover have been observed at ~20-60s when healthy.
 */
export function jobTimeoutMs(kind: string): number {
  if (kind === 'analyze') {
    const video = Number(process.env.OPENROUTER_VIDEO_TIMEOUT_MS ?? 300_000);
    return (Number.isFinite(video) && video > 0 ? video : 300_000) + 30_000;
  }
  if (kind === 'fetch') return 180_000;
  // Recreate photo restages finish in ~1-2min (8 slides × image gen); the
  // video variant adds the Gemini slide plan (upload + poll can eat 60s) on
  // top, so the cap covers the slower mode for both.
  if (kind === 'recreate') return 420_000;
  if (kind === 'thumb') return 30_000;
  if (kind === 'refresh' || kind === 'discover' || kind === 'rescore') return 120_000;
  return 120_000;
}

export interface MediaJobRow {
  id: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  deadlineAt: Date | null;
  preAuthCredits: number | null;
  kind: string;
  status: string;
  /** Single-owner transport marker: 'd1' | 'pg' | 'fallback_d1' (SLA-16). */
  queueOwner?: string | null;
  attempts: number;
  lastError: string | null;
  payloadJson: string;
  opId: string | null;
  analysisId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Retry cooldown — not claimable before this (NULL = available). */
  availableAt: Date | null;
}

/**
 * What every enqueue*Job returns: the job row, plus whether the transport
 * actually created it. `deduped: true` means NO new work exists — the publish
 * resolved to an existing row (see SLA-329: the returned `status` is that
 * row's, so it may already be terminal). Never log "queued" without checking.
 */
export type EnqueuedJob = MediaJobRow & { deduped: boolean };

export interface AnalyzeJobPayload {
  forceBackend?: 'gemini-native' | 'gemini-text' | 'openrouter-video';
}

/**
 * A fetch job downloads + stores the MP4 only (no Gemini analysis), so the
 * gallery can play a video and seek key moments without a full Gemini analysis
 * run. Fetch is charged against the Apify spend cap inside downloadTikTokVideo,
 * not AI credits, so these rows carry no opId and reclaimStuckJobs skips
 * refunding them (its `if (exhausted && job.opId)` guard).
 *
 * When enqueued as part of an analysis pipeline, `opId` and `enqueueAnalysis`
 * tell the fetch handler to chain an analyze job after a successful download,
 * or refund the pre-debited credits if the download fails.
 */
export interface FetchJobPayload {
  /** OpId minted by the original analyze_video call. Set when chaining to an
   *  analyze job — the fetch handler refunds credits if the download fails. */
  opId?: string;
  /** After successful download+store, enqueue an analyze job with these params. */
  enqueueAnalysis?: {
    forceBackend?: string;
  };
}

export async function enqueueRecreateJob(opts: {
  workspaceId: string;
  videoId: string;
  opId: string;
  preAuthCredits: number;
  /** 'video' when the target is an MP4 (slide plan + ffmpeg extraction). */
  payload?: { mode?: 'photo' | 'video' };
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'recreate',
    workspaceId: opts.workspaceId,
    videoId: opts.videoId,
    sourceId: null,
    payload: opts.payload ?? {},
    opId: opts.opId,
    preAuthCredits: opts.preAuthCredits,
  });
}

export async function enqueueFetchJob(opts: {
  workspaceId: string;
  videoId: string;
  payload?: FetchJobPayload;
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'fetch',
    workspaceId: opts.workspaceId,
    videoId: opts.videoId,
    sourceId: null,
    payload: opts.payload ?? {},
    // Copy the analyze pre-auth opId onto the row so reclaim/refund and the
    // fetch→analyze chain can see it without re-parsing payloadJson.
    opId: opts.payload?.opId ?? null,
    preAuthCredits: null,
  });
}

/**
 * Queue watch-page slideshow downloads for photo posts that scrape only
 * captured a photomode cover (or whose off-proxy slide ingest 403'd).
 * Dedupes against already-queued/running jobs for the same video.
 */
export async function enqueueSlideshowFetches(
  workspaceId: string,
  videoIds: string[],
): Promise<{ queued: number; skipped: number }> {
  let queued = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const videoId of videoIds) {
    if (!videoId || seen.has(videoId)) { skipped++; continue; }
    seen.add(videoId);
    const outstanding = await outstandingJobForVideo(videoId);
    if (outstanding && (outstanding.status === 'queued' || outstanding.status === 'running')) {
      skipped++;
      continue;
    }
    await enqueueFetchJob({ workspaceId, videoId, payload: {} });
    queued++;
  }
  return { queued, skipped };
}

/**
 * A deferred thumbnail ingest — the cover for a video a refresh pulled beyond
 * THUMB_INGEST_MAX_PER_RUN. Free to run (one image fetch, no Apify spend, no AI
 * credits), so like `fetch` it carries no opId/preAuthCredits and
 * reclaimStuckJobs never tries to refund it.
 *
 * The worker drains these shortly after they are queued, inside the source CDN
 * URL's lifetime. Before this kind existed the overflow stayed thumbStatus
 * 'none' forever and the gallery fell back to the short-lived TikTok CDN URL.
 */
export interface ThumbJobPayload {
  /** Source-CDN URL captured at enqueue; the worker falls back to the Video row. */
  thumbnailUrl?: string;
  /** Apify key-value-store URL captured at enqueue (preferred, public). Unset on backfill. */
  coverDownloadUrl?: string | null;
}

export async function enqueueThumbJob(opts: {
  workspaceId: string;
  videoId: string;
  payload?: ThumbJobPayload;
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'thumb',
    workspaceId: opts.workspaceId,
    videoId: opts.videoId,
    sourceId: null,
    payload: opts.payload ?? {},
    opId: null,
    preAuthCredits: null,
  });
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export async function enqueueAnalyzeJob(opts: {
  workspaceId: string;
  videoId: string;
  payload: AnalyzeJobPayload;
  opId: string;
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'analyze',
    workspaceId: opts.workspaceId,
    videoId: opts.videoId,
    sourceId: null,
    payload: opts.payload ?? {},
    opId: opts.opId,
    preAuthCredits: null,
  });
}

/**
 * A refresh job scrapes a SOURCE. It carries preAuthCredits because the
 * pre-authorisation scales with videoLimit — unlike analyze, which is a fixed
 * price — so the reclaim path cannot infer the refund from the kind alone.
 *
 * opId and preAuthCredits are minted HERE, once, and stay fixed across every
 * retry of this job. runRefresh() is told to use them instead of minting its
 * own — that is what makes a retry's debitCredits() call idempotent (same
 * refId as the attempt that got killed) instead of a second, unrecoverable
 * charge. Before this, runRefresh generated a fresh opId per *invocation*: a
 * scrape killed by the platform timeout mid-flight had already debited under
 * that opId, and because MediaJob.opId was never set, reclaimStuckJobs had no
 * refId to refund even on the exhausted-attempts path — the pre-auth simply
 * vanished. Confirmed live: two separate 30-credit pre-auths from timed-out
 * attempts with no matching settle/fail entry anywhere in CreditLedger.
 */
export interface RefreshJobPayload {
  limitOverride?: number;
  /**
   * Baseline / too_fresh follow-up: scrape this type+query instead of the
   * source's own. Must not join a tenant batch (different query shape).
   * Drained by the refresh worker so scoring scrapes use the same provider
   * (proxy) as hashtag refreshes.
   */
  sourceTypeOverride?: 'creator' | 'keyword' | 'hashtag' | 'collection';
  queryOverride?: string;
}

export function parseRefreshJobPayload(raw: string | null | undefined): RefreshJobPayload {
  try {
    const parsed = JSON.parse(raw || '{}') as RefreshJobPayload;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** True when this refresh must run solo (creator override / baseline top-up). */
export function isSoloRefreshPayload(payload: RefreshJobPayload): boolean {
  return Boolean(payload.sourceTypeOverride || payload.queryOverride);
}

/**
 * Ledger `tool` for a job-kind refund. Reclaim/abandon used to assume
 * everything that wasn't refresh was analyze — a discover pre-auth would
 * have been refunded under the wrong tool name (and the wrong price fallback).
 */
export function jobCreditTool(kind: string): string {
  if (kind === 'refresh') return 'refresh_source';
  if (kind === 'discover') return 'discover_mine';
  if (kind === 'recreate') return 'recreate_slideshow';
  return 'analyze_video';
}

/**
 * Discover probes are the same work as a refresh scrape (TikTok list through
 * the proxy adapter). A worker already draining `refresh` with
 * SCRAPER_PROVIDER=proxy claims them too, so compose does not need a new
 * WORKER_KINDS entry.
 */
export function expandWorkerKinds(kinds: string[], scraperProvider?: string): string[] {
  const provider = (scraperProvider ?? process.env.SCRAPER_PROVIDER ?? '').trim().toLowerCase();
  let out = kinds;
  if (kinds.includes('refresh') && !kinds.includes('discover') && provider === 'proxy') {
    out = [...out, 'discover'];
  }
  // Recreate slideshow is the same worker as analyze (OpenRouter image calls).
  if (out.includes('analyze') && !out.includes('recreate')) {
    out = [...out, 'recreate'];
  }
  return out;
}

/**
 * A discover probe: scrape a seed that is not (yet) a tracked Source.
 *
 * No videoId/sourceId — MediaJob_one_target allows both null only for this
 * kind. The mine result is written back onto payloadJson on complete so the
 * waiting API/MCP call can return the same SeedMineResult shape as an inline
 * scrape.
 */
export interface DiscoverJobPayload {
  sourceType: 'hashtag' | 'keyword' | 'creator';
  query: string;
  rationale: string;
  origin: 'input' | 'ai';
  alreadyTracked?: boolean;
  /** Stashed by the worker on success (or a completed empty/error probe). */
  result?: unknown;
}

export function parseDiscoverJobPayload(raw: string | null | undefined): DiscoverJobPayload {
  try {
    const parsed = JSON.parse(raw || '{}') as DiscoverJobPayload;
    if (!parsed || typeof parsed !== 'object') {
      return { sourceType: 'keyword', query: '', rationale: '', origin: 'input' };
    }
    const sourceType = parsed.sourceType === 'hashtag' || parsed.sourceType === 'creator' ? parsed.sourceType : 'keyword';
    const origin = parsed.origin === 'ai' ? 'ai' : 'input';
    return {
      sourceType,
      query: typeof parsed.query === 'string' ? parsed.query : '',
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      origin,
      alreadyTracked: parsed.alreadyTracked === true,
      result: parsed.result,
    };
  } catch {
    return { sourceType: 'keyword', query: '', rationale: '', origin: 'input' };
  }
}

export const DISCOVER_JOB_DEADLINE_MS = 5 * 60_000;

export async function enqueueDiscoverJob(opts: {
  workspaceId: string;
  payload: DiscoverJobPayload;
  opId: string;
  preAuthCredits: number;
  deadlineAt: Date;
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'discover',
    workspaceId: opts.workspaceId,
    videoId: null,
    sourceId: null,
    payload: {
      sourceType: opts.payload.sourceType,
      query: opts.payload.query,
      rationale: opts.payload.rationale,
      origin: opts.payload.origin,
      alreadyTracked: opts.payload.alreadyTracked ?? false,
    },
    deadlineAt: opts.deadlineAt,
    opId: opts.opId,
    preAuthCredits: opts.preAuthCredits,
  });
}

export async function enqueueRefreshJob(opts: {
  workspaceId: string;
  sourceId: string;
  payload: RefreshJobPayload;
  /** Videos this refresh is capped at — the same number runRefresh would use
   *  (limitOverride, or else the source's own videoLimit) — so the pre-auth
   *  minted here matches what the worker will actually charge for. */
  videoLimit: number;
  /** Wall clock after which await_job stops telling callers to keep waiting. */
  deadlineAt: Date;
}): Promise<EnqueuedJob> {
  const opId = randomUUID();
  const preAuthCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * opts.videoLimit);
  return enqueueRouted({
    kind: 'refresh',
    workspaceId: opts.workspaceId,
    videoId: null,
    sourceId: opts.sourceId,
    payload: opts.payload ?? {},
    deadlineAt: opts.deadlineAt,
    opId,
    preAuthCredits,
  });
}

/**
 * Rescoring a creator's videos across OTHER sources, as its own job.
 *
 * Split out of runRefresh because it was the step that kept getting killed.
 * Measured on a real run: the scrape, persist and in-source scoring finished
 * 48.2s into a 60s worker, leaving 11.3s for a cross-source rescore that had to
 * score 30 videos. It never completed, so the refresh was billed and the
 * outlier it was bought to re-measure kept its stale `estimated` score.
 *
 * Free to run — no Apify, no credits — so a retry costs nothing and it needs no
 * pre-authorisation.
 */
export interface RescoreJobPayload {
  /**
   * Rescore every source holding this creator's videos. Omit to rescore only
   * the job's own sourceId — which is how a whole-workspace rescore is split
   * into one job per source.
   */
  creatorHandle?: string;
}

export async function enqueueRescoreJob(opts: {
  workspaceId: string;
  /** The creator source that triggered this; satisfies the one-target CHECK. */
  sourceId: string;
  payload: RescoreJobPayload;
}): Promise<EnqueuedJob> {
  return enqueueRouted({
    kind: 'rescore',
    workspaceId: opts.workspaceId,
    videoId: null,
    sourceId: opts.sourceId,
    payload: opts.payload,
    opId: null,
    preAuthCredits: null,
  });
}

/**
 * Outstanding job for a source, so a caller is not told to pay twice.
 *
 * `kind` matters and defaults to 'refresh'. Several kinds now target a source —
 * a rescore is attached to one too — and rescores are free. Without the filter
 * a queued rescore makes the source look busy, and refresh_due_sources skips a
 * genuinely overdue paid refresh: a scheduled task that quietly does nothing.
 * Observed live, with a workspace-wide rescore in flight.
 *
 * Pass null to ask "any job at all", which is what a UI would want.
 *
 * QUEUE_FALLBACK_STATUS (`queued_remote`) counts as outstanding. A row parked
 * there after a failed PG publish (queueOwner='fallback_d1') is invisible to
 * every claimer — D1 claims select only queueOwner='d1' and PG has no row — but
 * the reconciler sweep WILL publish it and run it, so the work is genuinely
 * pending. Leaving it out of this filter is what let the SLA-140 paid
 * rescrape loop back in through a different door: observed 2026-10-01, the
 * stale sweep enqueued five identical 5-video creator scrapes for one source
 * over 62 minutes, each one re-checking a source whose previous row was parked
 * (dedupeKey d1:<MediaJob.id> on all five PG rows proves the reconciler, not
 * the enqueue, published them). Answering "nothing outstanding" for a queued
 * job is what makes a caller pay twice for the same scrape.
 */
export async function outstandingJobForSource(
  sourceId: string,
  kind: string | null = 'refresh',
): Promise<MediaJobRow | null> {
  return db.mediaJob.findFirst({
    where: {
      sourceId,
      status: { in: ['queued', 'running', QUEUE_FALLBACK_STATUS] },
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
  }) as unknown as Promise<MediaJobRow | null>;
}

/** The job a caller should be told about for this video, if any is outstanding. */
export async function outstandingJobForVideo(videoId: string): Promise<MediaJobRow | null> {
  return db.mediaJob.findFirst({
    where: { videoId, status: { in: ['queued', 'running'] } },
    orderBy: { createdAt: 'desc' },
  }) as unknown as Promise<MediaJobRow | null>;
}

export async function latestJobForVideo(
  videoId: string,
  kind: string,
): Promise<MediaJobRow | null> {
  const rows = await db.mediaJob.findMany({
    where: { videoId, kind, status: { in: ['queued', 'running', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    take: 1,
  }) as unknown as MediaJobRow[];
  return rows[0] ?? null;
}

/**
 * The newest analyze job worth reporting to a detail endpoint — queued/running
 * means "in progress, poll me"; a *failed* job is only worth surfacing when
 * there is no newer successful analysis to shout over, otherwise it's stale
 * noise competing with a real result (re-analyzed-and-won videos must not keep
 * showing last week's failure). Callers wanting just the outstanding job keep
 * using outstandingJobForVideo.
 */
export async function latestReportingJobForVideo(
  videoId: string,
  opts?: { newerThan?: Date },
): Promise<MediaJobRow | null> {
  const rows = (await db.mediaJob.findMany({
    where: { videoId, status: { in: ['queued', 'running', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })) as unknown as MediaJobRow[];
  const job = rows[0] ?? null;
  if (!job) return null;
  if (job.status === 'failed' && opts?.newerThan && job.createdAt <= opts.newerThan) return null;
  return job;
}

/**
 * Newest failed-fetch reason per video — the "why can't this video be
 * scraped?" surface for the gallery. One query for the whole card pool (then
 * newest-per-video), classified by classifyFetchError in src/lib/fetch-errors.ts.
 */
export async function latestFetchErrors(
  videoIds: string[],
): Promise<Record<string, { code: string; message: string }>> {
  if (videoIds.length === 0) return {};
  const ids = [...new Set(videoIds)];
  const rows: Array<{ videoId: string; lastError: string | null }> = [];
  await chunked(ids, async (chunk) => {
    const part = (await db.mediaJob.findMany({
      where: { videoId: { in: chunk }, kind: 'fetch', status: 'failed', lastError: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { videoId: true, lastError: true },
    })) as unknown as Array<{ videoId: string; lastError: string | null }>;
    rows.push(...part);
  });

  const out: Record<string, { code: string; message: string }> = {};
  for (const r of rows) {
    if (out[r.videoId]) continue; // first (newest) already recorded
    const info = classifyFetchError(r.lastError);
    if (info) out[r.videoId] = { code: info.code, message: info.message };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claim / complete
// ---------------------------------------------------------------------------

/**
 * Take the oldest queued job, atomically.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes this safe to call
 * from two invocations at once: the losers skip the locked row and take the
 * next one instead of blocking or double-claiming. Doing this as a read then a
 * write would let two workers run the same analysis and bill it twice.
 *
 * attempts increments on claim, not on failure — a worker that dies without
 * reporting anything has still consumed an attempt, and that is exactly the
 * case the retry limit exists to bound.
 */
export async function claimNextJob(kind = 'analyze'): Promise<MediaJobRow | null> {
  // Refresh jobs are held back for a short coalescing window so multi-tenant
  // batching has something to batch.
  //
  // Phase A was designed against a per-minute Vercel cron, where a minute of
  // enqueues piled up and one drain grouped them. The VPS worker polls every
  // WORKER_IDLE_MS (3s) and would claim a refresh the instant it appears —
  // peers queued two seconds later then scrape separately, and the batching is
  // dead code in production. Waiting costs a background loop nothing: refresh
  // latency is already minutes end to end (await_job is built for it).
  const holdMs = kind === 'refresh' ? refreshCoalesceMs() : 0;
  const claimableBefore = new Date(Date.now() - holdMs);
  if (dbDialect() === 'sqlite') {
    // D1/SQLite: no FOR UPDATE SKIP LOCKED — D1 is single-writer, so this
    // single UPDATE..subquery..RETURNING statement is atomic on its own; two
    // concurrent claimers serialize and the loser's subselect sees the row
    // already 'running'.
    //
    // Recreate video-mode rows (payloadJson mode:'video') are NEVER claimed
    // here: the ffmpeg path is gone and those state machines are stepped by
    // the Cloudflare Worker's video-recreate cron (recreate-video-stream.ts).
    // Single-owner (SLA-16): only D1-owned rows are claimable here. PG
    // projection ('pg') and fallback ('fallback_d1') rows are never selected
    // by legacy D1 claims.
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      UPDATE "MediaJob"
         SET "status" = 'running',
             "startedAt" = ${new Date()},
             "attempts" = "attempts" + 1
       WHERE "id" = (
         SELECT "id" FROM "MediaJob"
          WHERE "status" = 'queued' AND "kind" = ${kind}
            AND "queueOwner" = 'd1'
            AND (${kind} <> 'recreate' OR "payloadJson" NOT LIKE '%"mode":"video"%')
            AND "createdAt" <= ${claimableBefore}
            AND ("availableAt" IS NULL OR "availableAt" <= ${new Date()})
          ORDER BY "createdAt" ASC
          LIMIT 1
       )
      RETURNING *
    `;
    return rows[0] ? toMediaJobRow(rows[0]) : null;
  }
  const rows = await db.$queryRaw<MediaJobRow[]>`
    UPDATE "MediaJob"
       SET "status" = 'running',
           "startedAt" = now(),
           "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT "id" FROM "MediaJob"
        WHERE "status" = 'queued' AND "kind" = ${kind}
          AND "queueOwner" = 'd1'
          AND "createdAt" <= ${claimableBefore}
          AND ("availableAt" IS NULL OR "availableAt" <= now())
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Multi-kind batch claim — the idle-poll amortizer.
 *
 * An idle VPS round used to fire ONE claim query per WORKER_KIND; a
 * 7-kind maintenance worker at the 10s D1 idle was ~60k queries/day against
 * D1's read budget, ~97% of them returning nothing (`wrangler d1 insights`,
 * 2026-09-16: 64,446 claim polls, 1,880 claims). This claims up to `limit`
 * jobs across ALL kinds in a single atomic statement — same contract as
 * claimNextJob: oldest-first within a priority that follows the `kinds`
 * array order, the refresh coalescing hold, and the recreate video-mode
 * exclusion (those rows are stepped by the Worker's video-recreate cron).
 *
 * SQLite/D1 gets one UPDATE..IN(subquery)..RETURNING; Postgres falls back to
 * the per-kind claimNextJob loop (SKIP LOCKED is per-row there, and PG is the
 * pre-cutover legacy runtime).
 */
export async function claimNextJobs(kinds: string[], limit: number): Promise<MediaJobRow[]> {
  if (limit <= 0 || kinds.length === 0) return [];
  const kindList = [...new Set(kinds.filter(k => /^[a-z][a-z_]*$/.test(k)))];
  if (kindList.length === 0) return [];

  if (dbDialect() !== 'sqlite') {
    const out: MediaJobRow[] = [];
    while (out.length < limit) {
      let claimedAny = false;
      for (const kind of kindList) {
        const j = await claimNextJob(kind);
        if (j) {
          out.push(j);
          claimedAny = true;
          if (out.length >= limit) break;
        }
      }
      if (!claimedAny) break;
    }
    return out;
  }

  // Kinds are internal enum-ish strings validated by the regex above, so they
  // can inline into the priority CASE; everything user-shaped stays bound.
  // Single-owner (SLA-16): "queueOwner" = 'd1' keeps PG-projection and
  // fallback rows out of legacy D1 claims.
  const kindPlaceholders = kindList.map(() => '?').join(', ');
  const priorityCase = kindList.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
  const startedAt = new Date();
  const refreshBefore = new Date(Date.now() - refreshCoalesceMs());
  const now = new Date();
  const stmt: RawStatement = {
    sql: `UPDATE "MediaJob"
             SET "status" = 'running',
                 "startedAt" = ?,
                 "attempts" = "attempts" + 1
           WHERE "id" IN (
             SELECT "id" FROM "MediaJob"
              WHERE "status" = 'queued'
                AND "queueOwner" = 'd1'
                AND "kind" IN (${kindPlaceholders})
                AND "createdAt" <= CASE "kind" WHEN 'refresh' THEN ? ELSE ? END
                AND ("availableAt" IS NULL OR "availableAt" <= ?)
                AND ("kind" <> 'recreate' OR "payloadJson" NOT LIKE '%"mode":"video"%')
              ORDER BY CASE "kind" ${priorityCase} ELSE 99 END, "createdAt" ASC
              LIMIT ?
           )
           RETURNING *`,
    params: [startedAt, ...kindList, refreshBefore, startedAt, now, limit],
  };
  const results = await rawBatch([stmt]);
  return (results[0] ?? []).map((row) => toMediaJobRow(row as Record<string, unknown>));
}

/**
 * How long a queued refresh job waits before any worker may claim it, letting
 * peers for the same canonical query accumulate. 0 disables the hold (the old
 * claim-immediately behaviour).
 */
export function refreshCoalesceMs(): number {
  // Nothing to coalesce for when batching is off — claim immediately.
  if (!refreshBatchingEnabled()) return 0;
  const raw = process.env.REFRESH_COALESCE_MS;
  if (raw == null || raw.trim() === '') return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** Master switch for multi-tenant batching — off means one scrape per job. */
export function refreshBatchingEnabled(): boolean {
  return (process.env.REFRESH_BATCHING_ENABLED ?? '1') !== '0';
}

/**
 * Max other refresh jobs claimed alongside the leader for one Apify scrape.
 * Bounds fan-out work (persist/score/thumbs per source) inside one invocation.
 * Override with REFRESH_BATCH_PEER_CAP so a batch can be narrowed in prod
 * without a redeploy.
 *
 * Default is 4 (was 9) since the D1 cutover: fan-out is one per-source stream
 * of roughly 2-5 statements per scraped video (existence check, create/update,
 * score upsert, baseline upsert), and D1 caps a single invocation at 1000
 * queries with no parallel worker — with a ~200-video scrape the old 10-member
 * batch was ~5000 statements and parked a worker slot for up to jobTimeoutMs
 * (refresh = 120s). 4 keeps the same worst case ~2x lower than that ceiling
 * while batching still fires.
 */
export const REFRESH_BATCH_PEER_CAP_DEFAULT = 4;

export function refreshBatchPeerCap(): number {
  const raw = process.env.REFRESH_BATCH_PEER_CAP;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : REFRESH_BATCH_PEER_CAP_DEFAULT;
}

/** @deprecated use refreshBatchPeerCap() — kept so callers compile unchanged. */
export const REFRESH_BATCH_PEER_CAP = REFRESH_BATCH_PEER_CAP_DEFAULT;

// ---------------------------------------------------------------------------
// Canonical scrape lock — one Apify run per canonical query across containers
// ---------------------------------------------------------------------------

/**
 * How long a canonical-scrape lease is held before another worker may steal
 * it. Must comfortably exceed one scrape plus its fan-out; a worker killed
 * mid-batch (redeploy) blocks that query only until this expires.
 */
export const CANONICAL_LOCK_TTL_MS = 10 * 60_000;

/**
 * Take the lease for one canonical query, or fail immediately.
 *
 * WORKER_KINDS lets several containers drain `refresh` at once. SKIP LOCKED
 * stops two of them claiming the same JOB, but nothing stopped two of them
 * leading batches for the same canonical query at the same moment — two Apify
 * runs for `@foo`, which is precisely the spend batching exists to remove.
 *
 * This is a TTL row, NOT `pg_advisory_lock`. Session-level advisory locks are
 * wrong here: the workers connect through the Supabase pooler in transaction
 * pooling mode, where the backend holding the lock is returned to the pool
 * after each statement — the unlock can land on a different backend and the
 * lock leaks for the life of the process. A row with an expiry needs no
 * session affinity and self-heals when a worker is SIGKILLed mid-batch.
 *
 * The single UPSERT is the atomic part: `ON CONFLICT … WHERE expiresAt < now()`
 * lets exactly one caller win, and losers get zero rows back rather than
 * blocking.
 */
export async function acquireCanonicalLock(
  key: string,
  owner: string,
  ttlMs = CANONICAL_LOCK_TTL_MS,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    if (dbDialect() === 'sqlite') {
      // Same upsert in SQLite dialect: DO UPDATE ... WHERE + RETURNING, where
      // exactly one caller matches the expired-lease predicate and the losers
      // get zero rows back.
      const rows = await db.$queryRaw<Array<{ lockedBy: string }>>`
        INSERT INTO "CanonicalScrapeLock" ("key", "lockedBy", "lockedAt", "expiresAt")
        VALUES (${key}, ${owner}, ${new Date()}, ${expiresAt})
        ON CONFLICT ("key") DO UPDATE
           SET "lockedBy" = excluded."lockedBy",
               "lockedAt" = excluded."lockedAt",
               "expiresAt" = excluded."expiresAt"
         WHERE "CanonicalScrapeLock"."expiresAt" < ${new Date()}
       RETURNING "lockedBy"
      `;
      return rows[0]?.lockedBy === owner;
    }
    const rows = await db.$queryRaw<Array<{ lockedBy: string }>>`
      INSERT INTO "CanonicalScrapeLock" ("key", "lockedBy", "lockedAt", "expiresAt")
      VALUES (${key}, ${owner}, now(), ${expiresAt})
      ON CONFLICT ("key") DO UPDATE
         SET "lockedBy" = EXCLUDED."lockedBy",
             "lockedAt" = now(),
             "expiresAt" = EXCLUDED."expiresAt"
       WHERE "CanonicalScrapeLock"."expiresAt" < now()
   RETURNING "lockedBy"
    `;
    return rows[0]?.lockedBy === owner;
  } catch (err) {
    // Table not deployed yet (migration pending): fall back to the previous
    // behaviour rather than refusing every refresh. Duplicate scrapes are a
    // cost bug; refusing all refreshes is an outage.
    console.warn(`[jobs] canonical lock unavailable, proceeding unlocked: ${(err as Error).message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Scrape receipts — never buy the same dataset twice
//
// A refresh job that fails after the scrape (worker killed, persist error,
// budget exhausted mid-fan-out) is requeued and re-runs the actor from
// scratch. Measured across 215 refresh jobs: 77 were retried, for 139 EXTRA
// actor runs, all of them re-buying results Apify was still holding. That is
// ~27% of the Apify bill spent on data already paid for.
//
// The dataset behind a finished run stays readable, and reading it is not a
// billed actor run. So the fix is bookkeeping: write down where the data
// landed, and hand that back on the next attempt.
//
// Stored inside the existing payloadJson rather than in new columns — the
// receipt is per-attempt scratch, not a domain entity, and this needs no
// migration to start saving money.
// ---------------------------------------------------------------------------

/**
 * How long a receipt is trusted. Short on purpose: a refresh is supposed to
 * return CURRENT results, so resuming an hours-old dataset would save money by
 * serving stale data. Long enough to cover a retry, not long enough to matter
 * editorially.
 */
export const SCRAPE_RECEIPT_TTL_MS = 20 * 60_000;

export interface ScrapeReceipt {
  datasetId: string;
  runId?: string | null;
  /** Guards against replaying one query's dataset into another's refresh. */
  canonicalKey: string;
  /** Epoch ms. */
  at: number;
}

/**
 * Pull a still-valid receipt out of a job payload.
 *
 * Returns undefined for anything suspect — wrong query, too old, malformed.
 * A bad receipt must degrade to "scrape again" (costs money) and never to
 * "apply someone else's results" (corrupts a source).
 */
export function readScrapeReceipt(
  payloadJson: string | null | undefined,
  canonicalKey: string,
  now = Date.now(),
  ttlMs = SCRAPE_RECEIPT_TTL_MS,
): ScrapeReceipt | undefined {
  let receipt: ScrapeReceipt | undefined;
  try {
    receipt = (JSON.parse(payloadJson || '{}') as { scrapeReceipt?: ScrapeReceipt }).scrapeReceipt;
  } catch {
    return undefined;
  }
  if (!receipt?.datasetId || typeof receipt.datasetId !== 'string') return undefined;
  if (receipt.canonicalKey !== canonicalKey) return undefined;
  if (typeof receipt.at !== 'number' || now - receipt.at > ttlMs) return undefined;
  return receipt;
}

/** Merge a receipt into a payload without disturbing the rest of it. */
export function withScrapeReceipt(payloadJson: string | null | undefined, receipt: ScrapeReceipt): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(payloadJson || '{}') as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return JSON.stringify({ ...payload, scrapeReceipt: receipt });
}

/**
 * Attach a receipt to every job that shared the scrape, so whichever of them
 * is retried can resume. Best-effort: failing to save a receipt costs money on
 * a retry that may never happen, and must not fail the refresh that just
 * succeeded.
 *
 * One rawBatch (not N findUnique+update round-trips): json_patch merges the
 * receipt into each job's own payload, exactly like withScrapeReceipt below.
 * Malformed payloads are skipped via json_valid rather than aborting the
 * batch. Postgres keeps the legacy per-item loop.
 */
export async function recordScrapeReceipt(
  jobIds: string[],
  receipt: ScrapeReceipt,
): Promise<void> {
  if (jobIds.length === 0) return;
  if (dbDialect() === 'sqlite') {
    try {
      const patch = JSON.stringify({ scrapeReceipt: receipt });
      const statements: RawStatement[] = jobIds.map((id) => ({
        sql: `UPDATE "MediaJob" SET "payloadJson" = json_patch("payloadJson", ?)
               WHERE "id" = ? AND json_valid("payloadJson")`,
        params: [patch, id],
      }));
      // Chunk under the bridge's 50-statement cap — a batch is ≤ peer-cap+1
      // rows in practice, this is just belt-and-suspenders.
      for (let i = 0; i < statements.length; i += 40) {
        await rawBatch(statements.slice(i, i + 40));
      }
    } catch (err) {
      console.warn(`[jobs] could not record scrape receipt: ${(err as Error).message}`);
    }
    return;
  }
  for (const id of jobIds) {
    try {
      const job = await db.mediaJob.findUnique({ where: { id }, select: { payloadJson: true } });
      if (!job) continue;
      await db.mediaJob.update({
        where: { id },
        data: { payloadJson: withScrapeReceipt(job.payloadJson, receipt) },
      });
    } catch (err) {
      console.warn(`[jobs] could not record scrape receipt on job ${id}: ${(err as Error).message}`);
    }
  }
}

/** Release a lease we own. A lease we no longer own is left alone. */
export async function releaseCanonicalLock(key: string, owner: string): Promise<void> {
  await db.$executeRaw`
    DELETE FROM "CanonicalScrapeLock" WHERE "key" = ${key} AND "lockedBy" = ${owner}
  `.catch(() => { /* expiry clears it anyway */ });
}

type QueuedRefreshPeerRow = {
  id: string;
  workspaceId: string;
  sourceId: string;
  platform: string;
  sourceType: string;
  query: string;
  payloadJson: string;
  opId: string | null;
  preAuthCredits: number | null;
};

/**
 * Find queued refresh jobs whose Source matches platform + sourceType, then
 * filter by canonical query in JS (normalization is not expressible cleanly
 * in SQL). Claim the matching ids atomically.
 *
 * Used so multi-tenant refreshes of the same TikTok target share one scrape.
 */
export async function claimRefreshPeersForCanonical(opts: {
  excludeJobId: string;
  platform: string;
  sourceType: string;
  /** Already-normalized query (see canonical-query.ts). */
  queryNorm: string;
  limit?: number;
}): Promise<MediaJobRow[]> {
  const { normalizeQuery } = await import('./canonical-query.js');
  const cap = opts.limit ?? refreshBatchPeerCap();
  if (cap <= 0) return [];

  // Peek a wider candidate set, then claim only matching ids. FOR UPDATE is
  // applied at claim time so we do not hold locks across the JS filter.
  //
  // Deliberately NOT filtered on deadlineAt, unlike an earlier version.
  // deadlineAt (5 min) says whether a CALLER is still waiting for an answer,
  // not whether the work is still worth doing — and claimNextJob ignores it,
  // so an expired job runs as a batch LEADER regardless. Excluding it only
  // from the peer list meant a late job could not share a scrape it was about
  // to pay for on its own.
  //
  // That inverted the feature exactly where it pays. Batching helps a burst;
  // the worker drains serially at roughly one job a minute, so in a 9-source
  // sync everything after the fifth is already past a 5-minute deadline by the
  // time a leader looks for peers. Measured p90 queue wait is 935s. Joining a
  // batch is strictly cheaper for the peer than scraping alone, and the
  // deadline is honoured where it belongs — await_job stops promising results.
  const candidates = await db.$queryRaw<QueuedRefreshPeerRow[]>`
    SELECT mj."id",
           mj."workspaceId",
           mj."sourceId",
           mj."payloadJson",
           mj."opId",
           mj."preAuthCredits",
           s."platform",
           s."sourceType",
           s."query"
      FROM "MediaJob" mj
      JOIN "Source" s ON s."id" = mj."sourceId"
     WHERE mj."status" = 'queued'
       AND mj."queueOwner" = 'd1'
       AND mj."kind" = 'refresh'
       AND mj."id" <> ${opts.excludeJobId}
       AND s."platform" = ${opts.platform}
       AND s."sourceType" = ${opts.sourceType}
     ORDER BY mj."createdAt" ASC
     LIMIT 40
  `;

  // One job per sourceId. Two queued refreshes for the SAME source would be
  // two subscribers pointing at one set of Video rows: the second settles
  // against zero new videos but still burns its own pre-auth round trip, and
  // the caller's result-by-sourceId map can only pair one of them.
  const seenSources = new Set<string>([]);
  const matchIds: string[] = [];
  for (const c of candidates) {
    if (normalizeQuery(c.sourceType, c.query) !== opts.queryNorm) continue;
    if (seenSources.has(c.sourceId)) continue;
    seenSources.add(c.sourceId);
    matchIds.push(c.id);
    if (matchIds.length >= cap) break;
  }

  if (matchIds.length === 0) return [];

  return claimJobsByIds(matchIds);
}

/** Atomically claim a set of queued job ids (missing/raced ids are skipped). */
export async function claimJobsByIds(ids: string[]): Promise<MediaJobRow[]> {
  if (ids.length === 0) return [];
  // Prisma.$queryRaw cannot expand arrays into IN ($1,$2) without Prisma.join
  // in all versions — claim one-by-one is fine for N≤4 (REFRESH_BATCH_PEER_CAP_DEFAULT).
  const claimed: MediaJobRow[] = [];
  for (const id of ids) {
    if (dbDialect() === 'sqlite') {
      const rows = await db.$queryRaw<Record<string, unknown>[]>`
        UPDATE "MediaJob"
           SET "status" = 'running',
               "startedAt" = ${new Date()},
               "attempts" = "attempts" + 1
         WHERE "id" = (
           SELECT "id" FROM "MediaJob"
            WHERE "id" = ${id} AND "status" = 'queued'
              AND "queueOwner" = 'd1'
              AND ("availableAt" IS NULL OR "availableAt" <= ${new Date()})
         )
        RETURNING *
      `;
      if (rows[0]) claimed.push(toMediaJobRow(rows[0]));
      continue;
    }
    const rows = await db.$queryRaw<MediaJobRow[]>`
      UPDATE "MediaJob"
         SET "status" = 'running',
             "startedAt" = now(),
             "attempts" = "attempts" + 1
       WHERE "id" = (
         SELECT "id" FROM "MediaJob"
          WHERE "id" = ${id} AND "status" = 'queued'
            AND "queueOwner" = 'd1'
            AND ("availableAt" IS NULL OR "availableAt" <= now())
          FOR UPDATE SKIP LOCKED
       )
      RETURNING *
    `;
    if (rows[0]) claimed.push(rows[0]);
  }
  return claimed;
}

/**
 * Put a claimed job back in the queue and GIVE THE ATTEMPT BACK.
 *
 * `failJob` is the wrong tool when nothing was tried: attempts increment at
 * claim time, so a job that keeps losing a race — the canonical-scrape lease
 * is held by another container, say — would burn all MAX_ATTEMPTS and be
 * terminally failed for someone else's contention, without a single scrape
 * having been attempted on its behalf.
 *
 * Only for "we did not start": no Apify call, no credits moved, nothing
 * persisted. The retry limit still bounds real failures.
 */
/**
 * Optional PG lifecycle intercept (VPS worker). Cloudflare never sets this, so
 * the Worker bundle does not import `pg`. A sink that returns false/null falls
 * through to the D1 implementation. `forceD1` is the projection write after a
 * PG transition (same id, queueOwner=pg). The PG sink calls it only for the
 * states queue.d1.projection still mirrors (default: terminal done/failed).
 */
export interface JobLifecycleSink {
  completeJob(id: string, analysisId: string | null, payloadJson?: string): Promise<boolean>;
  failJob(
    id: string,
    message: string,
    opts?: { terminal?: boolean },
  ): Promise<{ terminal: boolean } | null>;
  yieldJob(id: string, reason: string): Promise<boolean>;
}

let jobLifecycleSink: JobLifecycleSink | null = null;

export function setJobLifecycleSink(sink: JobLifecycleSink | null): void {
  jobLifecycleSink = sink;
}

export async function yieldJob(
  id: string,
  reason: string,
  flags?: { forceD1?: boolean },
): Promise<void> {
  if (jobLifecycleSink && !flags?.forceD1) {
    if (await jobLifecycleSink.yieldJob(id, reason)) return;
  }
  if (dbDialect() === 'sqlite') {
    // SQLite scalar max() stands in for Postgres GREATEST.
    await db.$executeRaw`
      UPDATE "MediaJob"
         SET "status" = 'queued',
             "startedAt" = NULL,
             "attempts" = MAX(0, "attempts" - 1),
             "availableAt" = ${new Date(Date.now() + YIELD_COOLDOWN_MS)},
             "lastError" = ${reason.slice(0, 1000)}
       WHERE "id" = ${id}
    `;
    return;
  }
  await db.$executeRaw`
    UPDATE "MediaJob"
       SET "status" = 'queued',
           "startedAt" = NULL,
           "attempts" = GREATEST(0, "attempts" - 1),
           "availableAt" = ${new Date(Date.now() + YIELD_COOLDOWN_MS)},
           "lastError" = ${reason.slice(0, 1000)}
     WHERE "id" = ${id}
  `;
}

export async function completeJob(
  id: string,
  analysisId: string | null,
  /** Optional payload rewrite — discover jobs stash the mine result here. */
  payloadJson?: string,
  flags?: { forceD1?: boolean },
): Promise<void> {
  if (jobLifecycleSink && !flags?.forceD1) {
    if (await jobLifecycleSink.completeJob(id, analysisId, payloadJson)) return;
  }
  const job = await db.mediaJob.update({
    where: { id },
    data: {
      status: 'done',
      analysisId,
      finishedAt: new Date(),
      lastError: null,
      ...(payloadJson !== undefined ? { payloadJson } : {}),
    },
  });
  // A finished scrape ends the outage episode — re-arm the failure email.
  // Fire-and-forget: the job is already done; alerting must not be able to
  // turn a success into an error.
  void markScrapeSuccess(job.kind);
}

/**
 * Record a failed attempt.
 *
 * Returns whether this was terminal, because the caller owns the credit refund
 * and must only issue it once — a job going back to `queued` for another try
 * has not cost the user anything yet.
 *
 * `opts.terminal` forces the terminal state on the FIRST attempt, for failures
 * that are deterministic — a refusal that will read exactly the same on every
 * retry. An out-of-credits refresh re-debits (and refuses) identically on each
 * of its three lives, so requeueing it only triples the claim/debit/D1 cost of
 * a condition nothing short of a top-up can change; the sweeps re-enqueue much
 * later anyway.
 */
/**
 * Cooldown before a requeued job becomes claimable again. A failure that will
 * read identically on the next poll (provider down, proxy exhausted) must not
 * fail-claim-fail at the 10s poll speed across 3 containers — each cycle is a
 * claim UPDATE + failJob UPDATE (+ refund rows when terminal). Scales with the
 * spent attempt: the first retry waits 2min, the second 8min; the third life
 * is terminal anyway (MAX_ATTEMPTS).
 */
export function requeueBackoffMs(attempts: number): number {
  return (attempts >= 2 ? 8 : 2) * 60_000;
}

/**
 * How long a yielded job parks before it is claimable again. yieldJob means
 * "we did not start" (canonical-scrape lease held elsewhere, no budget left)
 * — reclaiming instantly would claim→yield loop at poll speed, 2 UPDATEs per
 * round per container, until the winner finishes minutes later.
 */
export const YIELD_COOLDOWN_MS = 60_000;

export async function failJob(
  id: string,
  message: string,
  opts?: { terminal?: boolean; forceD1?: boolean },
): Promise<{ terminal: boolean }> {
  if (jobLifecycleSink && !opts?.forceD1) {
    const handled = await jobLifecycleSink.failJob(id, message, opts);
    if (handled) return handled;
  }
  const job = await db.mediaJob.findUnique({ where: { id } });
  if (!job) return { terminal: false };

  const terminal = opts?.terminal === true || job.attempts >= MAX_ATTEMPTS;
  await db.mediaJob.update({
    where: { id },
    data: {
      status: terminal ? 'failed' : 'queued',
      lastError: message.slice(0, 1000),
      finishedAt: terminal ? new Date() : null,
      startedAt: terminal ? job.startedAt : null,
      // A requeued failure waits out its backoff before any worker may claim
      // it (see availableAt + the claim filters). Terminal rows leave the
      // column alone — they are never claimed again.
      ...(terminal ? {} : { availableAt: new Date(Date.now() + requeueBackoffMs(job.attempts)) }),
    },
  });
  // Fire-and-forget: scrape-outage email (one per outage episode, deduped in
  // the DB so both worker containers cannot double-send). Alerting must never
  // be able to fail or slow the job path.
  void notifyScrapeFailure(job.kind, message);
  return { terminal };
}

/**
 * Fail `queued` rows nobody ever drained, and give the credits back.
 *
 * reclaimStuckJobs only ever looked at `running`, so this whole class of job
 * was invisible to recovery: a row that is never CLAIMED has no startedAt, so
 * it can sit queued forever with the caller's pre-auth debited. Nothing
 * refunds it, nothing reports it, and get_source shows a refresh that is
 * perpetually about to happen. Every path that fails a claimed job refunds;
 * the one that never gets claimed did not.
 *
 * The threshold is deliberately far above normal latency rather than near the
 * 5-minute deadline. The queue is legitimately slow — refresh drains serially
 * at about one job a minute, measured p90 wait 935s and max 1937s — so
 * cancelling at the deadline would kill work that was going to run fine. This
 * is for a queue that is not draining at all (worker down, WORKER_KINDS
 * misconfigured, pg_cron disabled), which is an outage, not a backlog.
 */
export const QUEUED_ABANDONED_AFTER_MINUTES = 90;

/**
 * Hard cap on rows each recovery sweep processes per call.
 *
 * D1 caps one invocation at 1000 queries, and every swept row costs several
 * D1 statements: the status UPDATE, the refund (a 2-statement rawBatch), and
 * on reclaim the videos-landed findFirst. A full batch of 200 stays under the
 * cap — ~600 queries for the abandoned sweep, ~800 worst case for reclaim.
 * Older rows are picked first, so a stuck/abandoned storm degrades into
 * several small sweeps (both callers re-run them on their sweep interval)
 * instead of one invocation blowing its query budget mid-loop.
 */
export const QUEUE_SWEEP_TAKE = 200;

export async function failAbandonedQueuedJobs(
  olderThanMinutes = QUEUED_ABANDONED_AFTER_MINUTES,
): Promise<{ failed: number; refunded: number; more: boolean }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const abandoned = await db.mediaJob.findMany({
    // startedAt null is the discriminator: a job that has run and been
    // requeued is reclaimStuckJobs' business and may legitimately be old.
    // availableAt in the future exempts backoff-parked retries (failJob sets
    // now + 2/8min): without this the sweep would terminally fail jobs that
    // are simply waiting out their cooldown. NULL counts as available.
    where: {
      status: 'queued',
      // Single-owner (SLA-16): recovery only touches D1-owned rows. PG
      // projection ('pg') rows are owned by queue-db; fallback rows wait for
      // the one-way reconciler, not the abandoned-queue sweep.
      queueOwner: 'd1',
      createdAt: { lt: cutoff },
      startedAt: null,
      NOT: { availableAt: { gt: new Date() } },
    },
    select: {
      id: true, workspaceId: true, opId: true, kind: true, preAuthCredits: true,
      createdAt: true,
    },
    // Bound the per-invocation D1 work (see QUEUE_SWEEP_TAKE) the same way
    // reclaimStuckJobs does: an unbounded scan would exceed the 1000-query
    // cap once the per-row update + refund batch is factored in.
    take: QUEUE_SWEEP_TAKE,
    // Oldest first, so a capped sweep drains the rows that waited longest.
    orderBy: { createdAt: 'asc' },
  });

  let failed = 0;
  let refunded = 0;
  // Collected for ONE batched refund below: N per-job refunds would be N
  // Workspace UPDATEs on (usually) one row — the single-writer hotspot.
  // Same refund contract as reclaimStuckJobs: refund what was actually
  // pre-authorised, keyed on the job's own opId so credits.ts can make it
  // idempotent and the two reclaim paths cannot double-refund.
  const refundItems: RefundItem[] = [];

  for (const job of abandoned) {
    const waitedMin = Math.round((Date.now() - +job.createdAt) / 60_000);
    await db.mediaJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        lastError:
          `Never claimed by any worker after ${waitedMin} minutes — the queue is not draining. `
          + `Credits were refunded; re-run the refresh once workers are healthy.`,
      },
    });
    failed++;

    if (job.opId) {
      refundItems.push({
        workspaceId: job.workspaceId,
        credits: job.preAuthCredits ?? CREDIT_COSTS.analyzeVideo,
        tool: jobCreditTool(job.kind),
        refId: `${job.opId}:fail`,
        reason: 'call_failed',
      });
    }
  }

  if (refundItems.length > 0) {
    try {
      refunded = (await refundCreditsBatched(refundItems)).refunded;
    } catch (err) {
      console.warn(`[jobs] batched refund on abandoned-queue sweep failed: ${(err as Error).message}`);
    }
  }

  // more: the take cap was hit, so the abandoned set may still extend past
  // this batch — callers (the VPS worker loop) log that the queue stayed deep
  // and a later sweep will continue. False means the whole backlog drained.
  return { failed, refunded, more: abandoned.length >= QUEUE_SWEEP_TAKE };
}

/**
 * A publish the queue-api rate limiter refused (429) rather than a broken row.
 * Retrying it next sweep is the right move; retrying it in THIS sweep is not,
 * because the limiter's window (60s) has not moved and every further publish in
 * the batch would be refused too. See reconcileFallbackJobs.
 */
function isRateLimited(err: unknown): boolean {
  if (err instanceof ProducerHttpError) return err.code === 'rate_limited';
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'rate_limited';
}

/**
 * How long the fallback-reconcile throttle warning stays quiet after it is
 * emitted. The sweep runs every WORKER_RECLAIM_INTERVAL_MS (default 5 min),
 * so a backlog that outlives the limiter's 60s window used to re-warn on
 * every pass of every container. 15 minutes keeps a reader's hourly log
 * window to at most one line per process while still showing a change in
 * condition quickly, and the emitted line carries the count of the sweeps
 * that were folded into it. 0 disables throttling (every occurrence warns).
 */
const THROTTLE_LOG_EVERY_MS = (() => {
  const n = Number(process.env.WORKER_THROTTLE_LOG_EVERY_MS ?? 15 * 60_000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 15 * 60_000;
})();

const fallbackThrottleLog = createThrottle({ everyMs: THROTTLE_LOG_EVERY_MS });

/** The throttle window is process-wide, so tests need a way back to zero. */
export function resetFallbackThrottleLogForTests(): void {
  fallbackThrottleLog.reset();
}

/**
 * One-way fallback reconciliation (SLA-16). Picks D1 rows parked as
 * queueOwner='fallback_d1' status queued_remote (PG publish failed) and
 * republishes them with dedupeKey d1:<MediaJob.id> and the ORIGINAL opId.
 * Legacy D1 claims never select these rows; this sweep is what unparks them.
 *
 * The batch STOPS at the first 429. queue-api caps publishes at 30/minute per
 * workspace and 10/minute per kind+workspace (src/queue/api.ts
 * DEFAULT_RATE_LIMITS), so a burst parked by a failed publish exceeds the
 * budget by construction: the reconciler would then issue one doomed HTTP
 * round-trip per remaining row, log a warning for each, and publish nothing.
 * Stopping leaves the rest parked for the next sweep — they are selected again
 * by the same query, so nothing is lost — and turns N warnings into one. This
 * is what SLA-317's smoke test saw live: `reconciled=0 failed=25` repeating
 * while the backlog drained at the limiter's own 10/minute pace.
 *
 * The surviving warning is itself throttled (THROTTLE_LOG_EVERY_MS). Hitting
 * the publish limiter is a self-healing condition, not a fault — the same
 * rows come back on the next sweep — so warning on every pass of a
 * multi-minute drain is a log flood that hides real warnings. See
 * src/lib/log-throttle.ts.
 */
export async function reconcileFallbackJobs(opts?: {
  take?: number;
  publisher?: QueuePublisher;
}): Promise<{ reconciled: number; failed: number; more: boolean }> {
  const take = opts?.take ?? QUEUE_SWEEP_TAKE;
  const rows = await db.mediaJob.findMany({
    where: { queueOwner: 'fallback_d1', status: QUEUE_FALLBACK_STATUS },
    orderBy: { createdAt: 'asc' },
    take: take + 1,
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      videoId: true,
      sourceId: true,
      payloadJson: true,
      opId: true,
      preAuthCredits: true,
      deadlineAt: true,
      analysisId: true,
    },
  });
  const more = rows.length > take;
  const batch = more ? rows.slice(0, take) : rows;
  if (batch.length === 0) return { reconciled: 0, failed: 0, more: false };

  const pub = opts?.publisher ?? routedQueuePublisher();
  let reconciled = 0;
  let failed = 0;
  for (const row of batch) {
    try {
      await pub.reconcileFallbackRow({
        id: row.id,
        kind: row.kind,
        workspaceId: row.workspaceId,
        videoId: row.videoId,
        sourceId: row.sourceId,
        payloadJson: row.payloadJson,
        opId: row.opId,
        preAuthCredits: row.preAuthCredits,
        deadlineAt: row.deadlineAt,
        analysisId: row.analysisId,
      });
      reconciled++;
    } catch (err) {
      if (isRateLimited(err)) {
        // Budget spent for this window. The row stays parked and the next
        // sweep picks it up; `more` stays true so the caller loops again.
        // Log-gated: a throttled sweep is the expected steady state while a
        // backlog drains at the limiter's pace, and warning every pass filled
        // the log. The first pass warns; later passes fold into one line that
        // reports how many it swallowed, so the rate is still visible.
        const parked = batch.length - reconciled - 1;
        const line = fallbackThrottleLog.take('reconcile-throttled', (folded) =>
          `[jobs] fallback reconcile throttled by queue-api after ${reconciled} publish(es); ${parked} row(s) still parked`
          + foldedSuffix(folded));
        if (line) console.warn(line);
        return { reconciled, failed, more: true };
      }
      failed++;
      console.warn(`[jobs] fallback reconcile failed for ${row.id}: ${(err as Error).message}`);
    }
  }
  return { reconciled, failed, more };
}

/**
 * Return abandoned `running` rows to `queued`.
 *
 * Rows that have also exhausted their attempts go to `failed` instead, so a job
 * whose worker dies every time cannot cycle forever.
 */
export async function reclaimStuckJobs(): Promise<{ requeued: number; failed: number; refunded: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
  const stuck = await db.mediaJob.findMany({
    // Single-owner (SLA-16): only D1-owned running rows. PG-owned work is
    // reclaimed by the PG lease sweep (src/queue/pg.ts), never here.
    where: { status: 'running', queueOwner: 'd1', startedAt: { lt: cutoff } },
    select: {
      id: true, attempts: true, workspaceId: true, opId: true, kind: true,
      preAuthCredits: true, sourceId: true, startedAt: true,
    },
    // Bound the D1 response: a stuck storm (mass worker death) must degrade
    // into several small sweeps, not one giant query that times out the API.
    // STUCK_AFTER_MINUTES is 15 and the VPS sweep runs every ~5 min, so the
    // backlog between sweeps is at most a handful of rows in practice.
    // (Same per-invocation query cap as the abandoned sweep — QUEUE_SWEEP_TAKE.)
    take: QUEUE_SWEEP_TAKE,
    orderBy: { startedAt: 'asc' },
  });

  let requeued = 0;
  let failed = 0;
  let refunded = 0;
  const reclaimRefundItems: RefundItem[] = [];

  for (const job of stuck) {
    // A refresh whose scrape actually landed must never be retried.
    //
    // The money question is only ever "did we already pay Apify for these
    // videos?", so the evidence has to be the videos themselves. An earlier
    // version keyed on Source.lastRefreshedAt and had a hole: that field is
    // written at the very END of runRefresh, after thumbnail ingest and
    // scoring. A worker killed during those steps leaves the videos inserted
    // and paid for, but lastRefreshedAt untouched — so the guard saw nothing
    // and re-scraped. Observed live: 21 videos persisted at 06:32:49, worker
    // dead by ~06:33:25, lastRefreshedAt still three days old.
    //
    // Video.scrapedAt is written as each row is inserted, which is the earliest
    // durable proof the Apify call succeeded and therefore the right thing to
    // check.
    if (job.kind === 'refresh' && job.sourceId && job.startedAt) {
      const landed = await db.video.findFirst({
        where: { sourceId: job.sourceId, scrapedAt: { gt: job.startedAt } },
        select: { id: true },
      });
      if (landed) {
        await db.mediaJob.update({
          where: { id: job.id },
          data: {
            status: 'done',
            finishedAt: new Date(),
            lastError: 'Worker died after the scrape landed; recovered without re-scraping. '
              + 'Scoring may be incomplete — a rescore job covers that.',
          },
        });
        // The tail that died is scoring, and it is free to redo. Queue it
        // rather than leaving the new videos unscored, which is what makes a
        // paid refresh look like it did nothing.
        try {
          await db.mediaJob.create({
            data: {
              workspaceId: job.workspaceId,
              sourceId: job.sourceId,
              kind: 'rescore',
              status: 'queued',
              queueOwner: 'd1',
              payloadJson: '{}',
            },
          });
        } catch {
          // Best-effort: the job is already marked done and not re-charging,
          // which is the property that matters.
        }
        continue;
      }
    }

    const exhausted = job.attempts >= MAX_ATTEMPTS;
    await db.mediaJob.update({
      where: { id: job.id },
      data: exhausted
        ? { status: 'failed', finishedAt: new Date(), lastError: 'Worker did not report back; attempts exhausted' }
        : { status: 'queued', startedAt: null, lastError: 'Worker did not report back; requeued' },
    });

    // Refund here too, not only in the worker's catch.
    //
    // The worker refunds when it catches a failure — but a job killed by the
    // runtime timeout never reaches a catch block, so the process simply
    // vanishes with the caller already debited. Reclaiming such a job to
    // `failed` without refunding is how credits silently leak, and a timeout is
    // precisely the failure this queue exists to handle.
    //
    // refundCredits is idempotent on refId (see src/lib/credits.ts), so the two
    // paths cannot double-refund the same job.
    // Refund what was actually pre-authorised. preAuthCredits is written at
    // enqueue; the fallback covers analyze rows created before that column
    // existed. Assuming the analyze price for every kind would refund the wrong
    // amount the moment a second priced kind joined the queue. Collected for
    // one batched refund after the loop (see the abandoned sweep above).
    if (exhausted && job.opId) {
      reclaimRefundItems.push({
        workspaceId: job.workspaceId,
        credits: job.preAuthCredits ?? CREDIT_COSTS.analyzeVideo,
        tool: jobCreditTool(job.kind),
        refId: `${job.opId}:fail`,
        reason: 'call_failed',
      });
    }

    if (exhausted) failed++; else requeued++;
  }
  if (reclaimRefundItems.length > 0) {
    try {
      refunded += (await refundCreditsBatched(reclaimRefundItems)).refunded;
    } catch (err) {
      console.warn(`[jobs] batched refund on reclaim failed: ${(err as Error).message}`);
    }
  }
  return { requeued, failed, refunded };
}

