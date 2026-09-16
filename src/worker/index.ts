// ---------------------------------------------------------------------------
// VPS/Bun worker — the long-running queue drainer with NO 60s ceiling.
//
// Same queue, same state machine, same retry policy as the Vercel worker
// (api/jobs/analyze.ts): claim with FOR UPDATE SKIP LOCKED, process via
// processClaimedJob, complete/fail. The process has no 60s Vercel ceiling, so
// OpenRouter video analysis can finish. Each claimed job still has
// jobTimeoutMs(kind) so a hung TikTok fetch cannot occupy a concurrency slot
// until reclaimStuckJobs (15 min).
//
// Concurrency: claimNextJobs's atomic claim makes this safe to run ALONGSIDE the
// Vercel worker and the pg_cron drain — jobs are never double-claimed, whoever
// gets there first wins. WORKER_CONCURRENCY (default 2) also lets THIS process
// drain several claimed jobs at once. Each job runs inside withMeterScope()
// so its proxy bytes are attributed to it alone.
//
// Run:  bun run worker        (or the Docker image in worker/)
// Env:  Postgres mode (pre-cutover): DATABASE_URL, SUPABASE_URL +
//       SUPABASE_SECRET_KEY, storage buckets, OPENROUTER_API_KEY +
//       OPENROUTER_VIDEO_MODEL/MODE/TIMEOUT_MS, GEMINI_API_KEY, APIFY_API_KEY,
//       APIFY_SPEND_CAP_CENTS. DATABASE_URL is REQUIRED there.
//       D1 mode (post-cutover, retained VPS): DB_DIALECT=sqlite plus the D1
//       HTTP credentials D1_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN —
//       DATABASE_URL is NOT required and is ignored. src/db.ts picks the D1
//       HTTP client up from those vars automatically; startup below fails fast
//       with a clear message when the trio is incomplete.
//       WORKER_IDLE_MS controls the poll interval when idle: default 3000 in
//       Postgres mode, 10000 in D1 mode (D1 is single-writer with no cheap
//       per-3s polling — see docs/cloudflare-migration.md cutover §5).
//       WORKER_MAX_IDLE_MS caps the exponential idle backoff (empty queue
//       doubles the wait up to this, jittered; default 60000 in D1 mode,
//       15000 in Postgres). A claim resets the backoff to IDLE_MS.
//       WORKER_CONCURRENCY (default 2) is jobs drained in parallel. Raise
//       DB_CONNECTION_LIMIT with it (Postgres mode only; D1 serializes).
//       WORKER_RECLAIM_INTERVAL_MS (default 300000) throttles BOTH whole-queue
//       sweeps (stuck-claim reclaim + never-claimed fail) on the maintenance
//       worker. WORKER_INTERNAL_URL + CRON_SECRET route rawBatch through the
//       Worker's atomic /internal/raw-batch; without them multi-statement
//       batches run WITHOUT atomicity (dev only).
// ---------------------------------------------------------------------------

import {
  claimNextJobs, reclaimStuckJobs, failAbandonedQueuedJobs, expandWorkerKinds,
  failJob, jobTimeoutMs, jobCreditTool,
} from '../lib/jobs.js';
import { processClaimedJob } from './process-job.js';
import { rescoreStaleTooFresh } from '../scoring.js';
import { withMeterScope } from '../lib/scrapers/bandwidth.js';
import { refundCredits } from '../lib/credits.js';
import { initLogShipping } from './ship-logs.js';

// D1 is single-writer with per-request billing: the 3s Postgres poll default
// would hammer it from every container. In D1 mode (DB_DIALECT=sqlite) the
// idle default is 10000 — an explicit WORKER_IDLE_MS still wins in both modes.
const isD1Mode = (process.env.DB_DIALECT ?? 'postgres') === 'sqlite';
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? (isD1Mode ? 10000 : 3000));
// Idle backoff ceiling. ~97% of claim polls in production found an empty
// queue (64,446 polls → 1,880 claims on 2026-09-16), so an empty round backs
// off exponentially from IDLE_MS to here (jittered); any claim resets it.
// WORKER_MAX_IDLE_MS overrides; floor is IDLE_MS.
const MAX_IDLE_MS = (() => {
  const n = Number(process.env.WORKER_MAX_IDLE_MS ?? (isD1Mode ? 60_000 : 15_000));
  const fallback = isD1Mode ? 60_000 : 15_000;
  return Number.isFinite(n) && n >= IDLE_MS ? Math.floor(n) : fallback;
})();
const RESCORE_EVERY = Number(process.env.WORKER_RESCORE_EVERY ?? 60);
// Wall-clock cadence of rescoreStaleTooFresh. Historical meaning was "every
// RESCORE_EVERY claim rounds" — with idle backoff a round can now sit out
// 60s, which would silently stretch a 10-minute rescore to an hour. Same
// default as before (60 × 10s idle = 10 min), computed once from IDLE_MS.
const RESCORE_INTERVAL_MS = Math.max(60_000, RESCORE_EVERY * IDLE_MS);
const CONCURRENCY = Math.max(1, Math.floor(Number(process.env.WORKER_CONCURRENCY ?? 2)));
// Stuck-claim sweep cadence. Both recovery sweeps (reclaimStuckJobs and
// failAbandonedQueuedJobs) are whole-queue scans over the D1 HTTP API —
// running them every loop iteration on every container caused cascading D1
// timeouts (all 3 workers × every 3–10s). Both run at most this often,
// maintenance worker only.
const RECLAIM_INTERVAL_MS = (() => {
  const n = Number(process.env.WORKER_RECLAIM_INTERVAL_MS ?? 5 * 60_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 60_000;
})();

// Which MediaJob kinds this worker claims. WORKER_KINDS is a comma-separated
// list (e.g. "analyze,fetch" for video-only, or "refresh,rescore" for a
// maintenance worker). Unset = drain everything
// (fetch,analyze,thumb,discover,rescore,refresh).
// Order is priority: `thumb` sits just after analyze because it is cheap, fast,
// and time-sensitive — the cover must be ingested before the source CDN URL
// expires, so a backlog clears ahead of the slower rescore/refresh kinds.
// discover sits ahead of refresh (user is waiting on the Discover screen) and
// is claimed by any proxy refresh worker via expandWorkerKinds — no compose
// WORKER_KINDS change required.
const ALL_KINDS = ['fetch', 'analyze', 'recreate', 'thumb', 'discover', 'rescore', 'refresh'] as const;
function workerKinds(): string[] {
  const raw = (process.env.WORKER_KINDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const kinds = raw.length ? raw : [...ALL_KINDS];
  return expandWorkerKinds(kinds);
}
const KINDS = workerKinds();
// Ship console output to indiestack in the background (no-op unless
// INDIESTACK_LOG_URL is set; never throws, never blocks the loop). Installed
// before the first log line so startup is captured too.
initLogShipping(KINDS);
// Only the maintenance worker (refresh/rescore kinds) should spend Apify
// credits on the periodic stale-score top-up scrape — the video worker
// (analyze/fetch) must not double that spend.
const doesMaintenance = KINDS.includes('refresh') || KINDS.includes('rescore');

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Idle sleep that wakes early on SIGINT/SIGTERM so an idle worker exits
 * within ~250ms instead of sitting out the whole IDLE_MS. Only used between
 * claim rounds — in-flight jobs are never interrupted (see the signal
 * handlers above).
 */
async function idleSleep(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!shuttingDown && Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

// Fail fast on a misconfigured environment before the first claim. In D1
// mode DATABASE_URL is neither needed nor read (src/store.ts talks to D1
// over HTTP); in Postgres mode it is still required — no regression there.
function assertWorkerEnv(): void {
  if (isD1Mode) {
    const missing = ['D1_ACCOUNT_ID', 'D1_DATABASE_ID', 'D1_API_TOKEN']
      .filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(
        `[worker] DB_DIALECT=sqlite but missing ${missing.join(', ')} — `
        + 'the D1 HTTP client cannot start. Set the trio (see worker/.env.example); '
        + 'DATABASE_URL is not used in D1 mode.',
      );
      process.exit(1);
    }
    if (!process.env.WORKER_INTERNAL_URL || !process.env.CRON_SECRET) {
      console.warn(
        '[worker] WORKER_INTERNAL_URL/CRON_SECRET unset — rawBatch runs WITHOUT '
        + 'atomicity (sequential D1 REST calls). Set both in production so money '
        + 'paths stay transactional via /internal/raw-batch.',
      );
    }
    if (IDLE_MS < 10000) {
      console.warn(
        `[worker] WORKER_IDLE_MS=${IDLE_MS}ms is below the D1-safe 10000ms — `
        + 'per-3s polling from every container caused cascading timeouts on D1\'s '
        + 'single-writer (~10 qps budget). Explicit value wins, but 10000 is '
        + 'recommended in D1 mode (3000 OK in Postgres mode).',
      );
    }
  } else if (!process.env.DATABASE_URL) {
    console.error('[worker] DATABASE_URL is required in Postgres mode (DB_DIALECT != sqlite).');
    process.exit(1);
  }
}
assertWorkerEnv();

let shuttingDown = false;
let sigName = '';
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Checked BETWEEN jobs: the in-flight batch runs to completion (it may be
    // a ~170s billed scrape), so the deploy MUST allow stop_grace_period 300s
    // — see worker/Dockerfile. Only the idle sleep below wakes early.
    if (!shuttingDown) console.log(`[worker] received ${sig} — finishing in-flight jobs, then exiting`);
    shuttingDown = true;
    sigName = sig;
  });
}

console.log(`[worker] started — dialect=${isD1Mode ? 'sqlite(D1)' : 'postgres'} kinds=[${KINDS.join(', ')}] idle ${IDLE_MS}ms → max ${MAX_IDLE_MS}ms, concurrency ${CONCURRENCY}, rescore every ${Math.round(RESCORE_INTERVAL_MS / 1000)}s`);

// Staggered start so containers restarted together (deploy/watchtower) don't
// fire the first sweep in lockstep against D1's single writer.
let lastReclaimAt = Date.now() - Math.floor(Math.random() * RECLAIM_INTERVAL_MS);
let lastRescoreAt = Date.now() - Math.floor(Math.random() * RESCORE_INTERVAL_MS);
let idleRounds = 0;

while (!shuttingDown) {
  try {
    // Recovery sweeps — throttled, maintenance-only, staggered across
    // containers by the jittered lastReclaimAt below. BOTH sweeps are
    // whole-queue scans over the D1 HTTP API: running the never-claimed sweep
    // every iteration (every IDLE_MS) multiplied D1 single-writer load without
    // changing the outcome (its threshold is 90 minutes). A D1 blip in either
    // sweep must not abort the iteration (claiming continues below).
    if (doesMaintenance && Date.now() - lastReclaimAt >= RECLAIM_INTERVAL_MS) {
      lastReclaimAt = Date.now();
      const reclaimed = await reclaimStuckJobs().catch((err) => {
        console.warn(`[worker] stuck-job sweep failed: ${(err as Error).message}`);
        return { requeued: 0, failed: 0, refunded: 0 };
      });
      if (reclaimed.requeued || reclaimed.failed) {
        console.log(`[worker] reclaimed stuck: requeued=${reclaimed.requeued} failed=${reclaimed.failed} refunded=${reclaimed.refunded}`);
      }

      // Jobs that were never claimed at all. Same gate as the stuck sweep:
      // it is a whole-queue sweep with a 90-minute threshold, and having every
      // container race to do it every idle period would multiply the work
      // without changing the outcome.
      const abandoned = await failAbandonedQueuedJobs().catch((err) => {
        console.warn(`[worker] abandoned-queue sweep failed: ${(err as Error).message}`);
        return { failed: 0, refunded: 0, more: false };
      });
      if (abandoned.failed) {
        console.warn(
          `[worker] failed ${abandoned.failed} never-claimed job(s), refunded ${abandoned.refunded} `
          + `— the queue was not draining${abandoned.more
            ? ' and is still deep — the sweep hit its 200-row cap, more rows wait for the next sweep'
            : ''}`,
        );
      }
    }

    // Same idea as the Vercel worker's per-invocation rescoreStaleTooFresh:
    // scores stuck at 'too_fresh' usually clear by the next check. Time-based
    // (was every N claim rounds — backoff would otherwise stretch it) and
    // staggered across containers like the reclaim sweep; only on the
    // maintenance worker.
    if (doesMaintenance && RESCORE_EVERY > 0 && Date.now() - lastRescoreAt >= RESCORE_INTERVAL_MS) {
      lastRescoreAt = Date.now();
      await rescoreStaleTooFresh().catch((err) => {
        console.warn(`[worker] rescoreStaleTooFresh failed: ${(err as Error).message}`);
      });
    }

    // Claim up to CONCURRENCY jobs across ALL kinds in ONE statement, priority
    // following the ALL_KINDS order — the old per-kind loop fired one claim
    // query per kind per round (7 queries just to find an empty queue).
    const jobs = await claimNextJobs(KINDS, CONCURRENCY);

    if (jobs.length === 0) {
      // Exponential backoff on an empty queue — the common case (~97% of
      // polls). Jitter ±15% so sibling containers don't re-sync their polls.
      idleRounds++;
      const backoff = Math.min(IDLE_MS * 2 ** idleRounds, MAX_IDLE_MS);
      const jittered = Math.round(backoff * (0.85 + Math.random() * 0.3));
      await idleSleep(jittered);
      continue;
    }
    idleRounds = 0;

    await Promise.all(jobs.map(async (job) => {
      const t = Date.now();
      const budgetMs = jobTimeoutMs(job.kind);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          withMeterScope(() => processClaimedJob(job)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`job timed out after ${budgetMs}ms`)), budgetMs);
          }),
        ]);
        const secs = ((Date.now() - t) / 1000).toFixed(1);
        console.log(
          `[worker] ${job.kind} job ${job.id.slice(0, 8)} ` +
          `${result.ok ? 'ok' : result.requeued ? 'requeued' : 'FAILED'} in ${secs}s` +
          `${result.error ? ` — ${result.error.slice(0, 160)}` : ''}`,
        );
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[worker] ${job.kind} job ${job.id.slice(0, 8)} threw: ${message}`);
        // An uncaught throw or timeout used to leave the row `running` until
        // reclaimStuckJobs (15 min), which is how one hung scrape stalled the
        // whole queue. Fail it here so the next loop iteration can claim.
        try {
          const { terminal } = await failJob(job.id, message);
          if (terminal && job.opId) {
            await refundCredits(
              job.workspaceId,
              job.preAuthCredits ?? 0,
              jobCreditTool(job.kind),
              `${job.opId}:fail`,
              'call_failed',
            );
          }
        } catch (failErr) {
          console.error(`[worker] failJob after throw failed: ${(failErr as Error).message}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    // No sleep after a round: keep draining the backlog, then idle.
  } catch (err) {
    console.error(`[worker] loop error: ${(err as Error).message}`);
    await sleep(5000);
  }
}

console.log(`[worker] shutting down${sigName ? ` (${sigName})` : ''}`);
process.exit(0);
