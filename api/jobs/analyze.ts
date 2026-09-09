// POST /api/jobs/analyze — Cloudflare Worker queue orchestrator (Phase 2).
//
// Phase 2: the Worker drains CHEAP work only. Heavy work stays `queued` for
// external compute (the VPS/Bun worker, src/worker/index.ts), which has no
// invocation ceiling, the proxy scraper provider, and the Apify budget.
//
// KIND-ROUTING TABLE — who owns what. Heavy kinds are NEVER claimed here; a
// whole-queue drain that touched them would start scrapes/AI runs it cannot
// finish inside its budget, get killed mid-flight, and leave paid-for work
// stuck in `running` until the 15-minute reclaimer.
//
//   | kind     | owner             | why                                          |
//   |----------|-------------------|----------------------------------------------|
//   | thumb    | Worker (this)     | one image fetch+store, no Apify/AI, sub-30s  |
//   | rescore  | Worker (this)     | free recompute, no Apify/AI, one source each |
//   | fetch    | external compute  | Apify download (~90s), billed spend          |
//   | analyze  | external compute  | Gemini/OpenRouter pipeline (300s+)           |
//   | refresh  | external compute  | TikTok scrape (~20-170s), needs proxy        |
//   | discover | external compute  | probe scrape, needs proxy, billed pre-auth   |
//
// Maintenance is also Worker-side but THROTTLED (see below), never per tick:
// reclaimStuckJobs (abandoned `running` rows), failAbandonedQueuedJobs
// (never-claimed `queued` rows + refunds), rescoreStaleTooFresh (enqueue-only
// decisions plus free recompute — the scrapes it queues are `refresh` jobs
// owned by external compute, and it self-bounds to 15s).
//
// Callers: the every-minute scheduled tick (src/cf/worker.ts dispatches internally
// through route() with CRON_SECRET — one auth path) and a best-effort poke on
// enqueue. Correctness never rests on either: unprocessed rows simply stay
// queued for the next tick.
//
// Retry/refund policy lives in exactly one place — src/worker/process-job.ts
// (via claim->process->complete/fail). This file only claims cheap kinds and
// runs the throttled sweeps; it must NOT fork that logic.
//
// D1 discipline (do not regress): the sqlite branch of claimNextJob is a
// single atomic UPDATE..RETURNING (D1 is single-writer; no FOR UPDATE
// SKIP LOCKED), every D1 call carries a per-call timeout (timedD1 in
// src/cf/env.ts), DbBusyError propagates to the router's 503 mapping, and
// db.* calls are strictly sequential — never Promise.all(db.*).

import { claimNextJob, failAbandonedQueuedJobs, reclaimStuckJobs } from '../../src/lib/jobs.js';
import { rescoreStaleTooFresh } from '../../src/scoring.js';
import { processClaimedJob } from '../../src/worker/process-job.js';

/**
 * Stop claiming new work with this much of the budget left.
 *
 * Cheap jobs are sub-30s each; the loop drains as many as fit and leaves the
 * rest queued — the next tick continues. Heavy kinds never enter this loop
 * (see the kind-routing table above), so no REFRESH_MIN_BUDGET_MS-style guard
 * is needed here: nothing claimed here can outlive the budget the way an
 * opaque scrape could.
 */
const RESERVE_MS = 45_000;

/**
 * Minimum gap between whole-queue maintenance sweeps, per isolate.
 *
 * reclaimStuckJobs / failAbandonedQueuedJobs / rescoreStaleTooFresh each scan
 * whole tables against D1's single writer. The every-minute tick plus an enqueue poke
 * per request would otherwise run them constantly — and from every isolate at
 * once after a deploy. Module state is per isolate, so each isolate sweeps at
 * most this often; the scheduled tick fires 1/min on one isolate, so sweeps
 * effectively run every ~5th tick. Mirrors WORKER_RECLAIM_INTERVAL_MS on the
 * VPS worker (src/worker/index.ts).
 */
export const MAINTENANCE_SWEEP_INTERVAL_MS = 5 * 60_000;

// Initialized at module load (isolate start), not 0: isolates cold-started
// together by a deploy must NOT all sweep in lockstep against the single
// writer. First sweep happens one interval after isolate start — harmless,
// since the stuck (15min) and abandoned (90min) windows are far longer.
let lastSweepAt = Date.now();

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

  // Maintenance sweeps — throttled, sequential (never Promise.all over db.*).
  // A D1 blip here degrades to zeros, not a failed drain: the cheap-job loop
  // below still runs, and a real stall surfaces as DbBusyError from the claim
  // path, which the router maps to 503.
  const sweepsDue = Date.now() - lastSweepAt >= MAINTENANCE_SWEEP_INTERVAL_MS;
  let reclaimed = { requeued: 0, failed: 0, refunded: 0 };
  let abandoned = { failed: 0, refunded: 0 };
  let rescoredStale: { creatorsRescraped: number; sourcesRescoredOnly: number; skipped?: 'throttled' } = {
    creatorsRescraped: 0,
    sourcesRescoredOnly: 0,
    skipped: 'throttled',
  };
  if (sweepsDue) {
    lastSweepAt = Date.now();
    reclaimed = await reclaimStuckJobs().catch((err) => {
      console.warn(`[jobs] reclaimStuckJobs failed: ${(err as Error).message}`);
      return { requeued: 0, failed: 0, refunded: 0 };
    });
    abandoned = await failAbandonedQueuedJobs().catch((err) => {
      console.warn(`[jobs] failAbandonedQueuedJobs failed: ${(err as Error).message}`);
      return { failed: 0, refunded: 0 };
    });
    rescoredStale = await rescoreStaleTooFresh().catch((err) => {
      console.warn(`[jobs] rescoreStaleTooFresh failed: ${(err as Error).message}`);
      return { creatorsRescraped: 0, sourcesRescoredOnly: 0 };
    });
  }

  // Cheap kinds only, sequential claims. `thumb` first: its source CDN URL
  // expires, so a backlog clears ahead of the slower rescore kind. Heavy
  // kinds (fetch/analyze/refresh/discover) are left queued for external
  // compute — never claimed here, not even as a fallback.
  while (Date.now() - startedAt < RESERVE_MS) {
    const job = (await claimNextJob('thumb'))
      ?? (await claimNextJob('rescore'));
    if (!job) break;

    // No deadline/budget opts: those only gate `refresh`, which is never
    // claimed here. rescore/thumb run to completion inside the loop budget.
    const result = await processClaimedJob(job);

    processed.push({ jobId: job.id, videoId: job.videoId, ok: result.ok, error: result.error });

    // rescore/thumb never requeue for budget today; keep the guard so a
    // future cheap kind with a requeue path stops the loop instead of
    // spin-claiming.
    if (result.requeued) break;
  }

  return json(200, {
    drainedKinds: ['thumb', 'rescore'],
    heavyKinds: 'left-queued-for-external-compute',
    maintenance: sweepsDue ? 'ran' : 'throttled',
    reclaimed,
    abandoned,
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
