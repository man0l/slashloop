// ---------------------------------------------------------------------------
// VPS/Bun worker — the long-running queue drainer with NO 60s ceiling.
//
// Same queue, same state machine, same retry policy as the Vercel worker
// (api/jobs/analyze.ts): claim with FOR UPDATE SKIP LOCKED, process via
// processClaimedJob, complete/fail. The difference is this process has no
// wall-clock budget at all, so the long legs — Apify download, and OpenRouter
// video analysis (Qwen on a full-length clip needs >60s) — actually finish
// instead of being killed at the Vercel Hobby limit.
//
// Concurrency: claimNextJob's SKIP LOCKED makes this safe to run ALONGSIDE the
// Vercel worker and the pg_cron drain — jobs are never double-claimed, whoever
// gets there first wins.
//
// Run:  bun run worker        (or the Docker image in worker/)
// Env:  the same as Vercel — DATABASE_URL, SUPABASE_URL + SUPABASE_SECRET_KEY,
//       storage buckets, OPENROUTER_API_KEY + OPENROUTER_VIDEO_MODEL/MODE/
//       TIMEOUT_MS, GEMINI_API_KEY, APIFY_API_KEY, APIFY_SPEND_CAP_CENTS.
//       WORKER_IDLE_MS (default 3000) controls the poll interval when idle.
// ---------------------------------------------------------------------------

import { claimNextJob, reclaimStuckJobs, failAbandonedQueuedJobs } from '../lib/jobs.js';
import { processClaimedJob } from './process-job.js';
import { rescoreStaleTooFresh } from '../scoring.js';

const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 3000);
const RESCORE_EVERY = Number(process.env.WORKER_RESCORE_EVERY ?? 60);

// Which MediaJob kinds this worker claims. WORKER_KINDS is a comma-separated
// list (e.g. "analyze,fetch" for video-only, or "refresh,rescore" for a
// maintenance worker). Unset = drain everything (fetch,analyze,thumb,rescore,refresh).
// Order is priority: `thumb` sits just after analyze because it is cheap, fast,
// and time-sensitive — the cover must be ingested before the source CDN URL
// expires, so a backlog clears ahead of the slower rescore/refresh kinds.
const ALL_KINDS = ['fetch', 'analyze', 'thumb', 'rescore', 'refresh'] as const;
function workerKinds(): string[] {
  const raw = (process.env.WORKER_KINDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : [...ALL_KINDS];
}
const KINDS = workerKinds();
// Only the maintenance worker (refresh/rescore kinds) should spend Apify
// credits on the periodic stale-score top-up scrape — the video worker
// (analyze/fetch) must not double that spend.
const doesMaintenance = KINDS.includes('refresh') || KINDS.includes('rescore');

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let shuttingDown = false;
process.on('SIGINT', () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

console.log(`[worker] started — kinds=[${KINDS.join(', ')}] idle ${IDLE_MS}ms, rescore every ${RESCORE_EVERY} iterations`);

let iteration = 0;

while (!shuttingDown) {
  try {
    // Recover abandoned claims before taking new work — the single place the
    // retry policy is applied (same as the Vercel worker; never a second copy).
    const reclaimed = await reclaimStuckJobs();
    if (reclaimed.requeued || reclaimed.failed) {
      console.log(`[worker] reclaimed stuck: requeued=${reclaimed.requeued} failed=${reclaimed.failed} refunded=${reclaimed.refunded}`);
    }

    // Jobs that were never claimed at all. Only the maintenance worker runs
    // this: it is a whole-queue sweep, and having every container race to do
    // it would multiply the work without changing the outcome.
    if (doesMaintenance) {
      const abandoned = await failAbandonedQueuedJobs().catch((err) => {
        console.warn(`[worker] abandoned-queue sweep failed: ${(err as Error).message}`);
        return { failed: 0, refunded: 0 };
      });
      if (abandoned.failed) {
        console.warn(
          `[worker] failed ${abandoned.failed} never-claimed job(s), refunded ${abandoned.refunded} `
          + `— the queue was not draining`,
        );
      }
    }

    // Same idea as the Vercel worker's per-invocation rescoreStaleTooFresh:
    // scores stuck at 'too_fresh' usually clear by the next check. Runs every
    // N iterations (a few minutes at the default idle) instead of per minute —
    // only on the maintenance worker.
    if (doesMaintenance && RESCORE_EVERY > 0 && ++iteration % RESCORE_EVERY === 0) {
      await rescoreStaleTooFresh().catch((err) => {
        console.warn(`[worker] rescoreStaleTooFresh failed: ${(err as Error).message}`);
      });
    }

    // Claim in priority order, restricted to WORKER_KINDS. fetch + analyze are
    // the long legs this process exists for; rescore is free; refresh is
    // claimed last (it is the longest scrape and runs best on its own).
    let job = null;
    for (const kind of ALL_KINDS) {
      if (!KINDS.includes(kind)) continue;
      job = await claimNextJob(kind);
      if (job) break;
    }

    if (!job) {
      await sleep(IDLE_MS);
      continue;
    }

    const t = Date.now();
    const result = await processClaimedJob(job);
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.log(
      `[worker] ${job.kind} job ${job.id.slice(0, 8)} ` +
      `${result.ok ? 'ok' : result.requeued ? 'requeued' : 'FAILED'} in ${secs}s` +
      `${result.error ? ` — ${result.error.slice(0, 160)}` : ''}`,
    );
    // No sleep after a job: keep draining the backlog, then idle.
  } catch (err) {
    console.error(`[worker] loop error: ${(err as Error).message}`);
    await sleep(5000);
  }
}

console.log('[worker] shutting down');
process.exit(0);
