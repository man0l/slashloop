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
  forceBackend?: 'gemini-native' | 'gemini-text';
}

/**
 * A fetch job downloads + stores the MP4 only (no Gemini analysis), so the
 * gallery can play a video and seek key moments without a full analysis run.
 * Fetch is charged against the Apify spend cap inside downloadTikTokVideo, not
 * AI credits, so these rows carry no opId and reclaimStuckJobs skips refunding
 * them (its `if (exhausted && job.opId)` guard).
 */
export interface FetchJobPayload {}

export async function enqueueFetchJob(opts: {
  workspaceId: string;
  videoId: string;
}): Promise<MediaJobRow> {
  return db.mediaJob.create({
    data: {
      workspaceId: opts.workspaceId,
      videoId: opts.videoId,
      kind: 'fetch',
      status: 'queued',
      payloadJson: JSON.stringify({}),
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
  const rows = await db.$queryRaw<MediaJobRow[]>`
    UPDATE "MediaJob"
       SET "status" = 'running',
           "startedAt" = now(),
           "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT "id" FROM "MediaJob"
        WHERE "status" = 'queued' AND "kind" = ${kind}
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `;
  return rows[0] ?? null;
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
