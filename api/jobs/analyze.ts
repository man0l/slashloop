// POST /api/jobs/analyze — drain the queue on a time budget.
//
// This is now the Vercel (HTTP) worker shell. The per-job processing logic
// lives in src/worker/process-job.ts, shared with the long-running VPS/Bun
// worker (src/worker/index.ts). Both use the same claim->process->complete/fail
// cycle, the same retry policy, and the same credit/refund rules.
//
// Two callers, both authenticating with CRON_SECRET: the enqueuing request
// pokes it immediately (best-effort), and pg_cron pokes it every minute from
// inside Postgres (the reliable path).
//
// It reclaims abandoned claims itself rather than trusting a caller to have
// done so, which is what keeps the retry policy in one place.
//
// Processes jobs until the time budget runs low rather than exactly one, so a
// backlog drains without waiting for N dispatches. It stops early and leaves
// the rest queued — the next dispatch or the next sweep continues.

import { claimNextJob, reclaimStuckJobs } from '../../src/lib/jobs.js';
import { rescoreStaleTooFresh } from '../../src/scoring.js';
import { processClaimedJob } from '../../src/worker/process-job.js';

/**
 * Stop claiming new work with this much of the budget left.
 *
 * maxDuration is 60s (vercel.json). Claiming a job at 45s in would mean losing
 * it to the stuck-job sweeper 15 minutes later, having already charged an
 * attempt for work that never had time to run.
 */
const RESERVE_MS = 45_000;

/**
 * Budget a refresh needs before it is worth starting.
 *
 * A scrape is one opaque, uninterruptible call. Started with less than this
 * left it gets killed mid-flight — billed, half-applied, and only recovered by
 * the stuck sweeper 15 minutes later. Better to leave the row queued for the
 * next drain a minute away.
 */
const REFRESH_MIN_BUDGET_MS = 30_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'Unauthorized' });

  const startedAt = Date.now();
  const processed: Array<{ jobId: string; videoId: string | null; ok: boolean; error?: string }> = [];

  // Recover abandoned claims before taking new work.
  const reclaimed = await reclaimStuckJobs();

  // Same idea for scores stuck at 'too_fresh' — the 48h window has usually
  // passed by the next drain. Spends real Apify credits (bounded).
  const rescoredStale = await rescoreStaleTooFresh().catch((err) => {
    console.warn(`[jobs] rescoreStaleTooFresh failed: ${(err as Error).message}`);
    return { creatorsRescraped: 0, sourcesRescoredOnly: 0 };
  });

  while (Date.now() - startedAt < RESERVE_MS) {
    // When the VPS worker (src/worker) is running, it handles the long-legged
    // analyze and fetch jobs with no 60s ceiling — Vercel must NOT compete for
    // those (it can't finish a video analysis in 60s, wastes an attempt + a
    // credit, and wedges the job). Set WORKER_URL (or any truthy value) to
    // signal that the VPS worker is active; Vercel then drains only the quick
    // rescore/refresh jobs and still reclaims stuck rows.
    const vpsActive = Boolean(process.env.WORKER_URL || process.env.WORKER_ACTIVE);
    const job = vpsActive
      ? (await claimNextJob('rescore')) ?? (await claimNextJob('refresh'))
      : (await claimNextJob('fetch'))
        ?? (await claimNextJob('analyze'))
        ?? (await claimNextJob('rescore'))
        ?? (await claimNextJob('refresh'));
    if (!job) break;

    const result = await processClaimedJob(job, {
      deadlineMs: startedAt + RESERVE_MS,
      refreshRequiresMs: REFRESH_MIN_BUDGET_MS,
    });

    processed.push({ jobId: job.id, videoId: job.videoId, ok: result.ok, error: result.error });

    // If the job was requeued because of budget, stop claiming more.
    if (result.requeued) break;
  }

  return json(200, {
    reclaimed,
    rescoredStale,
    processed: processed.length,
    succeeded: processed.filter(p => p.ok).length,
    failed: processed.filter(p => !p.ok).length,
    durationMs: Date.now() - startedAt,
    jobs: processed,
  });
}

/** The queue is drained by POST only; a stray GET should say so, not 405-by-crash. */
export async function GET(): Promise<Response> {
  return json(405, { error: 'Method not allowed', hint: 'POST with Authorization: Bearer $CRON_SECRET' });
}
