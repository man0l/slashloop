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
// api/jobs/analyze.ts, which also applies the retry policy defined here; the
// per-minute schedule that drives it is
// supabase/migrations/*_pgcron_drain_analyze_jobs.sql.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { CREDIT_COSTS, refundCredits } from './credits.js';
import { classifyFetchError } from './fetch-errors.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

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

export interface MediaJobRow {
  id: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  deadlineAt: Date | null;
  preAuthCredits: number | null;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  payloadJson: string;
  opId: string | null;
  analysisId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

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

export async function enqueueFetchJob(opts: {
  workspaceId: string;
  videoId: string;
  payload?: FetchJobPayload;
}): Promise<MediaJobRow> {
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      videoId: opts.videoId,
      kind: 'fetch',
      status: 'queued',
      payloadJson: JSON.stringify(opts.payload ?? {}),
    },
  }) as unknown as Promise<MediaJobRow>;
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
}): Promise<MediaJobRow> {
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      videoId: opts.videoId,
      kind: 'thumb',
      status: 'queued',
      payloadJson: JSON.stringify(opts.payload ?? {}),
    },
  }) as unknown as Promise<MediaJobRow>;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export async function enqueueAnalyzeJob(opts: {
  workspaceId: string;
  videoId: string;
  payload: AnalyzeJobPayload;
  opId: string;
}): Promise<MediaJobRow> {
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      videoId: opts.videoId,
      kind: 'analyze',
      status: 'queued',
      payloadJson: JSON.stringify(opts.payload ?? {}),
      opId: opts.opId,
    },
  }) as unknown as Promise<MediaJobRow>;
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
  sourceTypeOverride?: 'creator' | 'keyword' | 'hashtag';
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
}): Promise<MediaJobRow> {
  const opId = randomUUID();
  const preAuthCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * opts.videoLimit);
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      sourceId: opts.sourceId,
      kind: 'refresh',
      status: 'queued',
      payloadJson: JSON.stringify(opts.payload ?? {}),
      deadlineAt: opts.deadlineAt,
      opId,
      preAuthCredits,
    },
  }) as unknown as Promise<MediaJobRow>;
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
}): Promise<MediaJobRow> {
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      sourceId: opts.sourceId,
      kind: 'rescore',
      status: 'queued',
      payloadJson: JSON.stringify(opts.payload),
    },
  }) as unknown as Promise<MediaJobRow>;
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
 */
export async function outstandingJobForSource(
  sourceId: string,
  kind: string | null = 'refresh',
): Promise<MediaJobRow | null> {
  return db.mediaJob.findFirst({
    where: {
      sourceId,
      status: { in: ['queued', 'running'] },
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
  const rows = (await db.mediaJob.findMany({
    where: { videoId: { in: ids }, kind: 'fetch', status: 'failed', lastError: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { videoId: true, lastError: true },
  })) as unknown as Array<{ videoId: string; lastError: string | null }>;

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
  const rows = await db.$queryRaw<MediaJobRow[]>`
    UPDATE "MediaJob"
       SET "status" = 'running',
           "startedAt" = now(),
           "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT "id" FROM "MediaJob"
        WHERE "status" = 'queued' AND "kind" = ${kind}
          AND "createdAt" <= ${claimableBefore}
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows[0] ?? null;
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
 */
export const REFRESH_BATCH_PEER_CAP_DEFAULT = 9;

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
 */
export async function recordScrapeReceipt(
  jobIds: string[],
  receipt: ScrapeReceipt,
): Promise<void> {
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

/** Atomically claim a set of queued job ids (SKIP LOCKED — missing/raced ids are skipped). */
export async function claimJobsByIds(ids: string[]): Promise<MediaJobRow[]> {
  if (ids.length === 0) return [];
  // Prisma.$queryRaw cannot expand arrays into IN ($1,$2) without Prisma.join
  // in all versions — claim one-by-one with SKIP LOCKED is fine for N≤9.
  const claimed: MediaJobRow[] = [];
  for (const id of ids) {
    const rows = await db.$queryRaw<MediaJobRow[]>`
      UPDATE "MediaJob"
         SET "status" = 'running',
             "startedAt" = now(),
             "attempts" = "attempts" + 1
       WHERE "id" = (
         SELECT "id" FROM "MediaJob"
          WHERE "id" = ${id} AND "status" = 'queued'
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
export async function yieldJob(id: string, reason: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "MediaJob"
       SET "status" = 'queued',
           "startedAt" = NULL,
           "attempts" = GREATEST(0, "attempts" - 1),
           "lastError" = ${reason.slice(0, 1000)}
     WHERE "id" = ${id}
  `;
}

export async function completeJob(id: string, analysisId: string | null): Promise<void> {
  await db.mediaJob.update({
    where: { id },
    data: { status: 'done', analysisId, finishedAt: new Date(), lastError: null },
  });
}

/**
 * Record a failed attempt.
 *
 * Returns whether this was terminal, because the caller owns the credit refund
 * and must only issue it once — a job going back to `queued` for another try
 * has not cost the user anything yet.
 */
export async function failJob(id: string, message: string): Promise<{ terminal: boolean }> {
  const job = await db.mediaJob.findUnique({ where: { id } });
  if (!job) return { terminal: false };

  const terminal = job.attempts >= MAX_ATTEMPTS;
  await db.mediaJob.update({
    where: { id },
    data: {
      status: terminal ? 'failed' : 'queued',
      lastError: message.slice(0, 1000),
      finishedAt: terminal ? new Date() : null,
      startedAt: terminal ? job.startedAt : null,
    },
  });
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

export async function failAbandonedQueuedJobs(
  olderThanMinutes = QUEUED_ABANDONED_AFTER_MINUTES,
): Promise<{ failed: number; refunded: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const abandoned = await db.mediaJob.findMany({
    // startedAt null is the discriminator: a job that has run and been
    // requeued is reclaimStuckJobs' business and may legitimately be old.
    where: { status: 'queued', createdAt: { lt: cutoff }, startedAt: null },
    select: {
      id: true, workspaceId: true, opId: true, kind: true, preAuthCredits: true,
      createdAt: true,
    },
  });

  let failed = 0;
  let refunded = 0;

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

    // Same refund contract as reclaimStuckJobs: refund what was actually
    // pre-authorised, keyed on the job's own opId so credits.ts can make it
    // idempotent and the two reclaim paths cannot double-refund.
    if (job.opId) {
      try {
        await refundCredits(
          job.workspaceId,
          job.preAuthCredits ?? CREDIT_COSTS.analyzeVideo,
          job.kind === 'refresh' ? 'refresh_source' : 'analyze_video',
          `${job.opId}:fail`,
          'call_failed',
        );
        refunded++;
      } catch (err) {
        console.warn(`[jobs] refund on abandoned-queue sweep failed for ${job.id}: ${(err as Error).message}`);
      }
    }
  }

  return { failed, refunded };
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
    where: { status: 'running', startedAt: { lt: cutoff } },
    select: {
      id: true, attempts: true, workspaceId: true, opId: true, kind: true,
      preAuthCredits: true, sourceId: true, startedAt: true,
    },
  });

  let requeued = 0;
  let failed = 0;
  let refunded = 0;

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
    // amount the moment a second priced kind joined the queue.
    if (exhausted && job.opId) {
      try {
        await refundCredits(
          job.workspaceId,
          job.preAuthCredits ?? CREDIT_COSTS.analyzeVideo,
          job.kind === 'refresh' ? 'refresh_source' : 'analyze_video',
          `${job.opId}:fail`,
          'call_failed',
        );
        refunded++;
      } catch (err) {
        console.warn(`[jobs] refund on reclaim failed for ${job.id}: ${(err as Error).message}`);
      }
    }

    if (exhausted) failed++; else requeued++;
  }
  return { requeued, failed, refunded };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function baseUrl(): string | null {
  const explicit = process.env.PUBLIC_URL?.replace(/\/$/, '');
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  return vercel ? `https://${vercel}` : null;
}

/**
 * Ask a worker invocation to pick up the queue. Never throws.
 *
 * Deliberately fire-and-mostly-forget: we want the worker's *invocation*
 * started, not its result. The abort below cuts our side loose after the
 * request is on the wire.
 *
 * This is best-effort by design, and the system does not depend on it. If the
 * dispatch is dropped — the enqueuing instance frozen before the socket
 * flushed, a cold start that outlives the abort — the row simply stays
 * `queued` and the pg_cron drain picks it up within a minute
 * (supabase/migrations/*_pgcron_drain_analyze_jobs.sql). That scheduler runs
 * inside Postgres and is not subject to the Vercel plan's daily cron cap, which
 * is what lets this call be an optimisation rather than the thing correctness
 * rests on.
 */
/**
 * `kind` is accepted for call-site clarity but every kind drains through the
 * same endpoint. api/jobs/analyze.ts claims fetch, analyze and refresh in turn,
 * because the Hobby plan's 12-function cap leaves no room for a second worker
 * route — see the comment there.
 */
export async function dispatchWorker(_kind: 'analyze' | 'refresh' | 'rescore' = 'analyze'): Promise<{ dispatched: boolean; reason?: string }> {
  const base = baseUrl();
  if (!base) return { dispatched: false, reason: 'no PUBLIC_URL or VERCEL_URL' };

  const secret = process.env.CRON_SECRET;
  if (!secret) return { dispatched: false, reason: 'CRON_SECRET not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${base}/api/jobs/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    return { dispatched: true };
  } catch (err) {
    // An abort here is the expected path, not a failure: the request was sent.
    const aborted = (err as Error).name === 'AbortError';
    if (aborted) return { dispatched: true };
    console.warn(`[jobs] worker dispatch failed: ${(err as Error).message}`);
    return { dispatched: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
