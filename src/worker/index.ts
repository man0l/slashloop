// ---------------------------------------------------------------------------
// VPS/Bun worker — the long-running queue drainer with NO 60s ceiling.
//
// The only queue drainer: claim with claimNextJobs, process via
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
  claimNextJobs, reclaimStuckJobs, failAbandonedQueuedJobs, reconcileFallbackJobs, expandWorkerKinds,
  failJob, jobTimeoutMs, jobCreditTool,
} from '../lib/jobs.js';
import {
  getQueueD1ProjectionMode,
  partitionKindsByTransport,
  shouldRunD1RecoverySweeps,
} from '../queue/transport.js';
import { claimPgJobs, connectPgQueue } from './pg-runtime.js';
import { processClaimedJob } from './process-job.js';
import { rescoreStaleTooFresh } from '../scoring.js';
import { withMeterScope } from '../lib/scrapers/bandwidth.js';
import { refundCredits } from '../lib/credits.js';
import { initLogShipping } from './ship-logs.js';
import { tick as experimentTick } from '../experiments/engine.js';
import { createKindBreaker } from './kind-breaker.js';
import { describeExperimentTickGate } from './experiment-tick.js';
import { controlEnabled, filterKindsByControl } from '../lib/worker-control.js';
import { snapshotD1Usage, deltaD1Usage, formatD1Usage, totalD1Usage } from '../lib/d1-usage.js';
import { errorDetail, errorMessage } from '../lib/error-detail.js';

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
//
// Declared BEFORE the experiments block below on purpose: doesExperiments is
// evaluated at module load and reads KINDS — declaring it later is a TDZ
// ReferenceError that crash-loops every container at startup (observed live
// 2026-09-27). experiment-tick.test.ts pins this ordering.
const ALL_KINDS = ['fetch', 'analyze', 'recreate', 'thumb', 'discover', 'rescore', 'refresh'] as const;
function workerKinds(): string[] {
  const raw = (process.env.WORKER_KINDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const kinds = raw.length ? raw : [...ALL_KINDS];
  return expandWorkerKinds(kinds);
}
const KINDS = workerKinds();

// Experiments advance on this loop (moved off the CF */2 cron: workerd's
// fetch context broke experiment media preparation — the VPS runs the same
// code fine). No extra cron trigger is consumed (Free plan cap). The tick is
// single-flight so MediaJob draining is never blocked, its failures are
// logged, never thrown, and while an experiment is active the loop re-ticks
// within EXPERIMENT_TICK_MIN_INTERVAL_MS — one tick already chains up to 3
// steps back-to-back, so provider-bound work progresses near-live instead of
// waiting on minute-scale cadence or the idle backoff.
//
// Single leader: every VPS container runs this loop, but only ONE of them may
// tick experiments — each tick's steps are Experiment UPDATEs + Workspace
// debits + ledger INSERTs, so N containers ticking means N× the D1 writes for
// the same experiment. Default owner is the maintenance (refresh-draining)
// worker; EXPERIMENT_TICK_ENABLED=1 forces on, =0 forces off.
const experimentGate = describeExperimentTickGate(KINDS);
const doesExperiments = experimentGate.enabled;
const EXPERIMENT_TICK_MIN_INTERVAL_MS = 5_000;
let lastExperimentTickAt = 0;
let experimentsActiveUntil = 0;
let experimentTickInFlight: Promise<unknown> | null = null;
// Consecutive ticks that wrote nothing (tasks backing off or inside their
// lease — reads only). After IDLE_TICK_STREAK_MAX of them the loop drops back
// to the 120s cadence even while an experiment reports active; the next slow
// tick re-arms fast cadence the moment real work (writes) resumes.
let idleTickStreak = 0;
const IDLE_TICK_STREAK_MAX = 3;
// Last logged step count — the per-tick line is logged only when the count
// changes or the tick wrote rows, so a steady 5s cadence doesn't crowd real
// errors out of the 400-entry log shipper.
let lastTickSteps = -1;
// Experiment gate visibility: log every transition, and re-log hourly while
// the tick is gated off so a parked fleet stays visible instead of silent.
let lastGateState = '';
let lastGateLogAt = 0;
const GATE_REMIND_EVERY_MS = 3_600_000;

// Which MediaJob kinds this worker claims — see the KINDS block above (kept
// before the experiments block: module-load evaluation order matters).
// Ship console output to indiestack in the background (no-op unless
// INDIESTACK_LOG_URL is set; never throws, never blocks the loop). Installed
// before the first log line so startup is captured too.
initLogShipping(KINDS);
// Only the maintenance worker (refresh/rescore kinds) should spend Apify
// credits on the periodic stale-score top-up scrape — the video worker
// (analyze/fetch) must not double that spend.
const doesMaintenance = KINDS.includes('refresh') || KINDS.includes('rescore');

// Per-kind circuit breaker (Phase 2 write budget): N consecutive failures of
// one kind park it for a cooldown instead of spending claim→fail cycles
// proving the outage is still there. Requeued/yielded jobs never count.
function breakerThreshold(): number {
  const n = Number(process.env.KIND_BREAKER_THRESHOLD ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}
function breakerCooldownMs(): number {
  const n = Number(process.env.KIND_BREAKER_COOLDOWN_MS ?? 5 * 60_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 60_000;
}
const kindBreaker = createKindBreaker({ threshold: breakerThreshold(), cooldownMs: breakerCooldownMs() });
let lastParkedKey = '';

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

let pgQueue: Awaited<ReturnType<typeof connectPgQueue>> = null;
try {
  pgQueue = await connectPgQueue();
  if (pgQueue) console.log('[worker] PG queue runtime connected');
} catch (err) {
  console.error(
    `[worker] PG queue runtime failed to connect: ${(err as Error).message} — claiming D1 kinds only`,
  );
  pgQueue = null;
}

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

console.log(`[worker] started — dialect=${isD1Mode ? 'sqlite(D1)' : 'postgres'} kinds=[${KINDS.join(', ')}] idle ${IDLE_MS}ms → max ${MAX_IDLE_MS}ms, concurrency ${CONCURRENCY}, rescore every ${Math.round(RESCORE_INTERVAL_MS / 1000)}s, experiments ${doesExperiments ? 'on' : 'off'} (${experimentGate.reason})`);
// Startup stagger so sibling containers (same image, restarted together by a
// deploy) don't walk the claim/experiment cadence in phase: each container
// offsets its first loop iteration by a random 0–5s before the while loop.
await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 5_000)));

// Staggered start so containers restarted together (deploy/watchtower) don't
// fire the first sweep in lockstep against D1's single writer.
let lastReclaimAt = Date.now() - Math.floor(Math.random() * RECLAIM_INTERVAL_MS);
let lastRescoreAt = Date.now() - Math.floor(Math.random() * RESCORE_INTERVAL_MS);
let idleRounds = 0;

// Consecutive loop-iteration failures (claimNextJobs threw — usually D1 down).
// A fixed sleep here re-fires into the outage at full rate from every
// container (the 2026-09-22 error storm); the streak backs off exponentially
// and a successful claim below resets it.
let errorRounds = 0;
// Failed experiment-tick gate: re-firing at the 5s active cadence through an
// outage multiplies the same storm, so a failed tick parks itself behind this
// timestamp. A successful tick clears it.
let experimentTickBackoffUntil = 0;
let experimentTickErrorRounds = 0;
const ERROR_BACKOFF_BASE_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 120_000;

/** Exponential backoff for the error streak above, jittered ±15% like the idle path. */
function errorBackoffMs(rounds: number): number {
  const backoff = Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (rounds - 1), ERROR_BACKOFF_MAX_MS);
  return Math.round(backoff * (0.85 + Math.random() * 0.3));
}

// D1 write-budget tripwire (Phase 4): per-container process totals against a
// warn threshold, at most one line per hour. Totals are PER CONTAINER —
// multiply by the container count for the account-wide burn rate. When this
// fires, park burners via the WorkerControl table (jobs.<kind>.enabled=0,
// experiments.enabled=0, stale_rescrape.enabled=0) instead of redeploying.
function d1WriteWarnRows(): number {
  const n = Number(process.env.D1_WRITE_WARN_ROWS ?? 70_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 70_000;
}
let lastBudgetWarnAt = 0;
const BUDGET_WARN_EVERY_MS = 60 * 60_000;
// One line when Phase 4 skips the D1 reclaim/abandoned scans (all kinds on PG
// and projection mode is not `full`). Reset when the sweeps run again.
let d1RecoverySkippedLogged = false;

while (!shuttingDown) {
  try {
    const usage = totalD1Usage();
    if (usage.writes >= d1WriteWarnRows() && Date.now() - lastBudgetWarnAt >= BUDGET_WARN_EVERY_MS) {
      lastBudgetWarnAt = Date.now();
      console.error(
        `[d1-budget] per-container writes ${usage.writes} (reads ${usage.reads}, queries ${usage.queries}) `
        + `at/above warn threshold ${d1WriteWarnRows()} — park burners via WorkerControl, see src/lib/worker-control.ts`,
      );
    }
    // Recovery sweeps — throttled, maintenance-only, staggered across
    // containers by the jittered lastReclaimAt below. BOTH sweeps are
    // whole-queue scans over the D1 HTTP API: running the never-claimed sweep
    // every iteration (every IDLE_MS) multiplied D1 single-writer load without
    // changing the outcome (its threshold is 90 minutes). A D1 blip in either
    // sweep must not abort the iteration (claiming continues below).
    if (doesMaintenance && Date.now() - lastReclaimAt >= RECLAIM_INTERVAL_MS) {
      lastReclaimAt = Date.now();
      const sweepSnap = snapshotD1Usage();
      // Phase 4: once every kind is on PG, the D1 reclaim/abandoned scans
      // match nothing (they select queueOwner='d1' only) but still hit D1
      // every interval. Claim polls are already skipped below when d1Kinds
      // is empty. Fallback reconcile stays — it is the live fallback path.
      // A control-plane miss fail-opens to D1 ownership inside
      // partitionKindsByTransport, so an outage still runs the sweeps.
      const projectionMode = await getQueueD1ProjectionMode().catch(() => 'terminal' as const);
      const ownership = await partitionKindsByTransport([...ALL_KINDS]).catch(() => ({
        d1: [...ALL_KINDS],
        pg: [] as string[],
      }));
      const runD1Recovery = shouldRunD1RecoverySweeps(projectionMode, ownership.d1.length);
      const reclaimed = runD1Recovery
        ? await reclaimStuckJobs().catch((err) => {
            console.warn(`[worker] stuck-job sweep failed: ${(err as Error).message}`);
            return { requeued: 0, failed: 0, refunded: 0 };
          })
        : { requeued: 0, failed: 0, refunded: 0 };
      if (reclaimed.requeued || reclaimed.failed) {
        console.log(`[worker] reclaimed stuck: requeued=${reclaimed.requeued} failed=${reclaimed.failed} refunded=${reclaimed.refunded}`);
      }

      // Jobs that were never claimed at all. Same gate as the stuck sweep:
      // it is a whole-queue sweep with a 90-minute threshold, and having every
      // container race to do it every idle period would multiply the work
      // without changing the outcome.
      const abandoned = runD1Recovery
        ? await failAbandonedQueuedJobs().catch((err) => {
            console.warn(`[worker] abandoned-queue sweep failed: ${(err as Error).message}`);
            return { failed: 0, refunded: 0, more: false };
          })
        : { failed: 0, refunded: 0, more: false };
      if (!runD1Recovery && !d1RecoverySkippedLogged) {
        d1RecoverySkippedLogged = true;
        console.log(
          `[worker] D1 recovery sweeps skipped (projection=${projectionMode}, no d1-owned kinds)`,
        );
      } else if (runD1Recovery) {
        d1RecoverySkippedLogged = false;
      }
      const fallback = await reconcileFallbackJobs().catch((err) => {
        console.warn(`[worker] fallback reconcile sweep failed: ${(err as Error).message}`);
        return { reconciled: 0, failed: 0, more: false, backlog: 0, oldestAt: null };
      });
      if (fallback.reconciled || fallback.failed) {
        console.log(
          `[worker] fallback reconcile reconciled=${fallback.reconciled} failed=${fallback.failed}`
          + (fallback.more ? ' (more remain)' : ''),
        );
      }
      // Backlog visibility (SLA-354): a parked row is invisible to every
      // claimer until this sweep republishes it, and the PG-side queue
      // metrics cannot see it (it lives in D1 MediaJob). While a backlog
      // exists, one line per maintenance sweep reports its size and the
      // reconcile lag (age of the oldest parked row, the sweep-start
      // snapshot) — silent parking now has a metric in the shipped logs.
      if (fallback.backlog > 0) {
        const oldestSec = fallback.oldestAt
          ? Math.max(0, Math.round((Date.now() - fallback.oldestAt.getTime()) / 1000))
          : -1;
        console.log(
          `[worker] fallback backlog parked=${fallback.backlog} oldest=${oldestSec}s `
          + `— reconciled=${fallback.reconciled} failed=${fallback.failed} this sweep`,
        );
      }
      if (pgQueue) {
        const pgStuck = await pgQueue.recoverExpiredLeases().catch((err) => {
          console.warn(`[worker] PG stuck-job sweep failed: ${(err as Error).message}`);
          return { requeued: 0, failed: 0, more: false };
        });
        const pgAbandoned = await pgQueue.failAbandonedQueued().catch((err) => {
          console.warn(`[worker] PG abandoned-queue sweep failed: ${(err as Error).message}`);
          return { failed: 0, more: false };
        });
        if (pgStuck.requeued || pgStuck.failed || pgAbandoned.failed) {
          console.log(
            `[worker] PG sweep requeued=${pgStuck.requeued} failed=${pgStuck.failed} abandoned=${pgAbandoned.failed}`,
          );
        }
      }
      const sweepUsage = formatD1Usage(deltaD1Usage(sweepSnap));
      if (abandoned.failed) {
        console.warn(
          `[worker] failed ${abandoned.failed} never-claimed job(s), refunded ${abandoned.refunded} `
          + `— the queue was not draining${abandoned.more
            ? ' and is still deep — the sweep hit its 200-row cap, more rows wait for the next sweep'
            : ''}${sweepUsage}`,
        );
      } else if (reclaimed.requeued || reclaimed.failed) {
        console.log(
          `[worker] sweep requeued=${reclaimed.requeued} failed=${reclaimed.failed}${sweepUsage}`,
        );
      } else {
        // Whole-sweep cost is otherwise invisible in the D1 budget — one
        // line per sweep interval proves the idle case is cheap.
        console.log(`[worker] sweep idle${sweepUsage}`);
      }
    }

    // Same idea as the Vercel worker's per-invocation rescoreStaleTooFresh:
    // scores stuck at 'too_fresh' usually clear by the next check. Time-based
    // (was every N claim rounds — backoff would otherwise stretch it) and
    // staggered across containers like the reclaim sweep; only on the
    // maintenance worker.
    if (doesMaintenance && RESCORE_EVERY > 0 && Date.now() - lastRescoreAt >= RESCORE_INTERVAL_MS) {
      lastRescoreAt = Date.now();
      const rescoreSnap = snapshotD1Usage();
      await rescoreStaleTooFresh()
        .then(({ creatorsRescraped, sourcesRescoredOnly, creatorsDeduped, creatorsDedupedTerminal, creatorsAttemptCooldown }) => {
          if (creatorsRescraped || sourcesRescoredOnly || creatorsDeduped || creatorsAttemptCooldown) {
            // deduped is printed on purpose: a nonzero value means publishes
            // that created nothing. If it ever climbs while rescraped stays 0,
            // the queue is not draining this work (see SLA-329). dedupedTerminal
            // is the sharper signal (SLA-141): those created nothing AND left
            // nothing in flight, so a nonzero value is an anomaly, not traffic.
            // cooldown is the opposite of an anomaly (SLA-140): sweeps that
            // declined to re-buy a scrape already paid for in the last 6h and
            // ran the free recompute. A creator stuck at too_fresh across
            // repeat sweeps shows up as rescraped=0 cooldown=N climbing —
            // before this counter that state was indistinguishable from an
            // idle sweep.
            console.log(
              `[worker] rescoreStaleTooFresh rescraped=${creatorsRescraped} rescored=${sourcesRescoredOnly} deduped=${creatorsDeduped} dedupedTerminal=${creatorsDedupedTerminal} cooldown=${creatorsAttemptCooldown}${formatD1Usage(deltaD1Usage(rescoreSnap))}`,
            );
          }
        })
        .catch((err) => {
          console.warn(`[worker] rescoreStaleTooFresh failed: ${errorMessage(err)}`);
        });
    }

    // Experiment engine: drive planning/generation steps on the VPS (no 60s
    // ceiling). While any experiment is planning/generating the loop re-ticks
    // within 5s (one tick chains up to 3 steps); idle experiments back off to
    // the 120s cadence. MediaJob draining is never blocked: the tick runs
    // single-flight, detached from the claim round below.
    //
    // Two gates: doesExperiments (single leader by WORKER_KINDS, Phase 1) and
    // the experiments.enabled control row (Phase 4 kill switch, cached 60s).
    // Both are logged on every transition (and hourly while off) so a parked
    // experiment is distinguishable from a healthy idle one in the logs.
    const controlOn = await controlEnabled('experiments.enabled').catch(() => true);
    const experimentsAllowed = doesExperiments && controlOn;
    const gateState = experimentsAllowed
      ? 'on'
      : `off (env tick ${doesExperiments ? 'on' : 'off'} [${experimentGate.reason}], control experiments.enabled=${controlOn ? 'on' : 'off'})`;
    if (gateState !== lastGateState
      || (!experimentsAllowed && Date.now() - lastGateLogAt >= GATE_REMIND_EVERY_MS)) {
      lastGateState = gateState;
      lastGateLogAt = Date.now();
      console.log(`[worker] experiment tick gate: ${gateState}`);
    }
    if (!experimentTickInFlight
      && experimentsAllowed
      && Date.now() >= experimentTickBackoffUntil
      && Date.now() - lastExperimentTickAt >= (Date.now() < experimentsActiveUntil ? EXPERIMENT_TICK_MIN_INTERVAL_MS : 120_000)) {
      lastExperimentTickAt = Date.now();
      const tickSnap = snapshotD1Usage();
      experimentTickInFlight = experimentTick(120_000)
        .then(({ steps, active }) => {
          const usage = deltaD1Usage(tickSnap);
          if (steps > 0 && (steps !== lastTickSteps || usage.writes > 0)) {
            console.log(`[worker] experiment tick advanced ${steps} step(s)${formatD1Usage(usage)}`);
          }
          lastTickSteps = steps;
          if (active && (steps === 0 || usage.writes > 0)) {
            // Real work settled (or nothing attempted) — stay fast / re-arm.
            experimentsActiveUntil = Date.now() + 10 * 60_000;
            idleTickStreak = 0;
          } else if (active) {
            // Active but pure reads several ticks running: backoff/lease
            // waits, not progress. Park behind the slow cadence; a later
            // tick with writes re-arms automatically.
            idleTickStreak++;
            if (idleTickStreak >= IDLE_TICK_STREAK_MAX) {
              console.warn(
                `[worker] experiment STALLED? still active after ${idleTickStreak} consecutive read-only ticks (no writes) — parked to slow cadence. Check EXPERIMENT_TICK_ENABLED / experiments.enabled and stuck experiment rows.`,
              );
              experimentsActiveUntil = 0;
              idleTickStreak = 0;
            }
          } else {
            experimentsActiveUntil = 0;
            idleTickStreak = 0;
          }
          experimentTickErrorRounds = 0;
          experimentTickBackoffUntil = 0;
        })
        .catch((err) => {
          experimentTickErrorRounds++;
          const delay = errorBackoffMs(experimentTickErrorRounds);
          experimentTickBackoffUntil = Date.now() + delay;
          const detail = errorDetail(err);
          console.error(
            `[worker] experiment tick failed (streak ${experimentTickErrorRounds}, next attempt in ~${Math.round(delay / 1000)}s): ${detail}`,
          );
        })
        .finally(() => { experimentTickInFlight = null; });
    }

    // Claim up to CONCURRENCY jobs across ALL kinds in ONE statement, priority
    // following the ALL_KINDS order — the old per-kind loop fired one claim
    // query per kind per round (7 queries just to find an empty queue).
    // Parked kinds (breaker open after consecutive failures, or disabled via
    // the WorkerControl table) are excluded so an outage waits out its
    // cooldown instead of burning claim→fail cycles.
    const breakerKinds = kindBreaker.filterKinds(KINDS);
    const claimKinds = await filterKindsByControl(breakerKinds).catch(() => breakerKinds);
    const { d1: d1Kinds, pg: pgKinds } = await partitionKindsByTransport(claimKinds);
    const pgUnconfigured = pgKinds.length > 0 && !pgQueue ? pgKinds.join(',') : '';
    const parkedKey = [
      KINDS.filter((k) => !claimKinds.includes(k)).join(','),
      pgUnconfigured ? `pg-unconfigured:${pgUnconfigured}` : '',
    ].filter(Boolean).join(',');
    if (parkedKey !== lastParkedKey) {
      lastParkedKey = parkedKey;
      console.log(parkedKey ? `[worker] kinds parked: ${parkedKey}` : '[worker] all kinds claimable again');
    }
    if (claimKinds.length === 0 || (d1Kinds.length === 0 && (!pgQueue || pgKinds.length === 0))) {
      // Every kind cooling, disabled, or PG-owned without QUEUE_DATABASE_URL.
      idleRounds++;
      const backoff = Math.min(IDLE_MS * 2 ** idleRounds, MAX_IDLE_MS);
      await idleSleep(Math.round(backoff * (0.85 + Math.random() * 0.3)));
      continue;
    }
    const d1Jobs = d1Kinds.length ? await claimNextJobs(d1Kinds, CONCURRENCY) : [];
    const pgJobs =
      pgQueue && pgKinds.length ? await claimPgJobs(pgQueue, pgKinds, CONCURRENCY) : [];
    const jobs = [...d1Jobs, ...pgJobs];
    // Claim succeeded — D1 answered, whatever the queue depth. Streak resets
    // here (not on a claimed job) so a healthy-but-empty D1 clears the
    // outage backoff too.
    errorRounds = 0;

    if (jobs.length === 0) {
      // Exponential backoff on an empty queue — the common case (~97% of
      // polls). Jitter ±15% so sibling containers don't re-sync their polls.
      // While an experiment is active the sleep caps at the 5s re-tick
      // interval so planning/generation is never parked behind idle backoff.
      idleRounds++;
      const backoff = Math.min(IDLE_MS * 2 ** idleRounds, MAX_IDLE_MS);
      const jittered = Math.round(backoff * (0.85 + Math.random() * 0.3));
      const capped = Date.now() < experimentsActiveUntil ? Math.min(jittered, EXPERIMENT_TICK_MIN_INTERVAL_MS) : jittered;
      await idleSleep(capped);
      continue;
    }
    idleRounds = 0;

    await Promise.all(jobs.map(async (job) => {
      const t = Date.now();
      const jobSnap = snapshotD1Usage();
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
          `${result.error ? ` — ${result.error.slice(0, 160)}` : ''}` +
          formatD1Usage(deltaD1Usage(jobSnap)),
        );
        // Breaker input: successes reset, real failures count, requeued
        // ("never started") is neutral.
        if (result.ok) kindBreaker.record(job.kind, true);
        else if (!result.requeued) kindBreaker.record(job.kind, false);
      } catch (err) {
        const message = (err as Error).message;
        kindBreaker.record(job.kind, false);
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
    errorRounds++;
    const delay = errorBackoffMs(errorRounds);
    console.error(
      `[worker] loop error (streak ${errorRounds}, retrying in ~${Math.round(delay / 1000)}s): ${(err as Error).message}`,
    );
    // idleSleep (not a bare sleep) so SIGINT/SIGTERM still exits promptly even
    // deep in the backoff.
    await idleSleep(delay);
  }
}

console.log(`[worker] shutting down${sigName ? ` (${sigName})` : ''}`);
process.exit(0);
