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

import { db } from '../db.js';

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
  videoId: string;
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

/** The job a caller should be told about for this video, if any is outstanding. */
export async function outstandingJobForVideo(videoId: string): Promise<MediaJobRow | null> {
  return db.mediaJob.findFirst({
    where: { videoId, status: { in: ['queued', 'running'] } },
    orderBy: { createdAt: 'desc' },
  }) as unknown as Promise<MediaJobRow | null>;
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
export async function reclaimStuckJobs(): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
  const stuck = await db.mediaJob.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });

  let requeued = 0;
  let failed = 0;
  for (const job of stuck) {
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    await db.mediaJob.update({
      where: { id: job.id },
      data: exhausted
        ? { status: 'failed', finishedAt: new Date(), lastError: 'Worker did not report back; attempts exhausted' }
        : { status: 'queued', startedAt: null, lastError: 'Worker did not report back; requeued' },
    });
    if (exhausted) failed++; else requeued++;
  }
  return { requeued, failed };
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
export async function dispatchWorker(): Promise<{ dispatched: boolean; reason?: string }> {
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
