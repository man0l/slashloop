// ---------------------------------------------------------------------------
// PG queue adapter — the worker-side transport over queue_jobs.
//
// Contract (plan rev 4 §Worker adapter):
// - enqueue, ordered batch claim, lease renewal, yield, complete, fail with
//   the existing 2-min/8-min backoff + MAX_ATTEMPTS, queued cancellation,
//   bounded recovery sweeps, canonical locks.
// - The claim builds the priority CASE from the caller's WORKER_KINDS order,
//   applies the refresh coalesce hold, excludes video-mode recreates, and
//   returns rows the caller maps via toMediaJobShape — processClaimedJob
//   keeps single ownership of retry/refund/business-result policy and is NOT
//   forked here.
// - Minimal Db surface ({ query }) so the adapter works over node-postgres,
//   pgbouncer, or any compatible pool. No Prisma, no D1 imports.
// - dedupe_key means IN FLIGHT, not "has ever existed" (SLA-329): every
//   terminal transition clears it, and enqueue releases a terminal holder
//   before retrying its insert, so a source's second refresh is a real job
//   again instead of a silent dedupe onto a finished one.
// ---------------------------------------------------------------------------

import {
  expandQueueKinds,
  isTerminalJobState,
  normalizeKindList,
  queueBackoffMs,
  QUEUE_ABANDONED_AFTER_MINUTES,
  QUEUE_CANONICAL_LOCK_TTL_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_REFRESH_COALESCE_MS_DEFAULT,
  QUEUE_STUCK_AFTER_MINUTES,
  QUEUE_TERMINAL_STATE_SQL,
  QUEUE_YIELD_COOLDOWN_MS,
  type PgQueueJobRow,
} from './contract.js';

/** Minimal query surface (node-postgres compatible). */
export interface QueueDb {
  query<T = PgQueueJobRow>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface EnqueueInput {
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  /** Required for externally enqueued jobs; null for internal rows. */
  dedupeKey: string | null;
  deadlineAt?: Date | null;
  payload?: unknown;
  opId?: string | null;
  preAuthCredits?: number | null;
  maxAttempts?: number;
  analysisId?: string | null;
  d1JobId?: string | null;
}

export interface EnqueueResult {
  row: PgQueueJobRow;
  /** True when no new row was created because the key was already held. */
  deduped: boolean;
}

export interface ClaimOptions {
  batchSize: number;
  workerId: string;
  /** Lease lifetime in seconds (default: STUCK_AFTER_MINUTES window). */
  leaseSeconds?: number;
  /** Refresh coalesce hold in ms (0 disables, like REFRESH_COALESCE_MS=0). */
  refreshCoalesceMs?: number;
  scraperProvider?: string;
}

export interface SweepResult {
  requeued: number;
  failed: number;
  /** Cap was hit — more expired rows may remain. */
  more: boolean;
}

export type RefundHandler = (job: {
  workspaceId: string;
  opId: string;
  preAuthCredits: number;
  kind: string;
}) => Promise<void>;

/** Refresh scrape-landed probe (worker supplies the D1/Video check). */
export type ScrapeLandedProbe = (job: PgQueueJobRow) => Promise<boolean>;
export type RescoreTailHandler = (job: PgQueueJobRow) => Promise<void>;

const CLAIM_ROW = `job_id, dedupe_key, kind, state, attempts, max_attempts,
  claimed_by, lease_expires_at, workspace_id, video_id, source_id,
  payload, result, op_id, pre_auth_credits, deadline_at, analysis_id,
  available_at, started_at, finished_at, last_error, cancel_requested_at,
  d1_synced_at, d1_job_id, created_at, updated_at`;

// The batch claim is UPDATE..FROM (two tables in scope), so its RETURNING
// list must be qualified — bare `job_id` is ambiguous (42702) on real PG.
const CLAIM_ROW_Q = CLAIM_ROW.split(',')
  .map((c) => `q.${c.trim()}`)
  .join(', ');

/**
 * Release the dedupe key of a TERMINAL holder (SLA-329).
 *
 * `queue_jobs.dedupe_key` is UNIQUE and NULLs are distinct under UNIQUE, so a
 * terminal job that keeps its key makes every later publish of the same
 * logical job dedupe onto it forever. Exported so the transition statements
 * and the enqueue retry path can never drift apart — and so the tests can
 * assert the one SQL shape that fixes the defect.
 */
export const RELEASE_TERMINAL_DEDUPE_SQL = `UPDATE queue_jobs
   SET dedupe_key = NULL,
       updated_at = now()
 WHERE dedupe_key = $1
   AND state IN (${QUEUE_TERMINAL_STATE_SQL})`;

/**
 * Build the ordered batch-claim statement. Pure (unit-tested without a DB):
 * - kind list is allowlisted by normalizeKindList, then expanded exactly like
 *   expandWorkerKinds (refresh→discover on proxy, analyze→recreate);
 * - priority CASE follows the caller's kind order, then created_at, job_id;
 * - refresh rows honor the coalesce hold; video-mode recreates are excluded;
 * - FOR UPDATE SKIP LOCKED lets N workers claim without double-claims.
 */
export function buildClaimQuery(
  kinds: string[],
  opts: { batchSize: number; workerId: string; leaseSeconds: number; refreshCoalesceMs: number },
): { text: string; values: unknown[] } {
  const kindList = expandQueueKinds(kinds, process.env.SCRAPER_PROVIDER);
  if (kindList.length === 0 || opts.batchSize <= 0) {
    throw new Error('claim requires at least one known kind and batchSize >= 1');
  }
  const priorityCase = kindList.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
  const kindLiterals = kindList.map((k) => `'${k}'`).join(', ');
  const text = `
WITH next_jobs AS (
  SELECT job_id
    FROM queue_jobs
   WHERE state = 'queued'
     AND available_at <= now()
     AND kind IN (${kindLiterals})
     AND created_at <= CASE kind
           WHEN 'refresh' THEN now() - make_interval(secs => $1)
           ELSE now()
         END
     AND (kind <> 'recreate' OR coalesce(payload->>'mode', '') <> 'video')
   ORDER BY CASE kind ${priorityCase} ELSE 99 END, created_at, job_id
   FOR UPDATE SKIP LOCKED
   LIMIT $2
)
UPDATE queue_jobs AS q
   SET state = 'running',
       attempts = q.attempts + 1,
       claimed_by = $3,
       lease_expires_at = now() + make_interval(secs => $4),
       started_at = coalesce(q.started_at, now()),
       updated_at = now()
  FROM next_jobs
 WHERE q.job_id = next_jobs.job_id
RETURNING ${CLAIM_ROW_Q}`;
  return {
    text,
    values: [opts.refreshCoalesceMs / 1000, opts.batchSize, opts.workerId, opts.leaseSeconds],
  };
}

export class PgQueue {
  constructor(
    private readonly db: QueueDb,
    private readonly opts?: {
      onTerminalRefund?: RefundHandler;
      isRefreshLanded?: ScrapeLandedProbe;
      onRescoreTail?: RescoreTailHandler;
    },
  ) {}

  // -- enqueue -------------------------------------------------------------

  /**
   * Insert a job; on dedupe-key conflict return the existing row with
   * deduped=true (same opId/credits — never a second billing operation).
   * Nonce handling lives in the API layer (inserted atomically alongside).
   *
   * The key means "this logical job is in flight", NOT "it once existed"
   * (SLA-329). A TERMINAL holder is released and the insert is retried, so a
   * source's second/third refresh publishes a real job again. Concurrency is
   * unchanged: the unique index still arbitrates, and the loser of a race
   * re-reads by key and dedupes onto the winner — two concurrent publishes of
   * one logical job still produce exactly one row.
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const allowed = normalizeKindList([input.kind]);
    if (allowed.length === 0) throw new Error(`unknown kind "${input.kind}"`);
    const payloadJson = JSON.stringify(input.payload ?? {});
    const values = [
      input.d1JobId ?? null,
      input.dedupeKey,
      input.kind,
      input.workspaceId,
      input.videoId,
      input.sourceId,
      payloadJson,
      input.opId ?? null,
      input.preAuthCredits ?? null,
      input.deadlineAt ?? null,
      input.maxAttempts ?? QUEUE_MAX_ATTEMPTS,
      input.analysisId ?? null,
      input.d1JobId ?? null,
    ];
    // Shared id with the D1 projection when the producer pre-allocates one
    // (SLA-16 1:1 link). Otherwise Postgres mints job_id.
    const insert = () =>
      this.db.query<PgQueueJobRow>(
        `INSERT INTO queue_jobs
           (job_id, dedupe_key, kind, workspace_id, video_id, source_id, payload,
            op_id, pre_auth_credits, deadline_at, max_attempts, analysis_id, d1_job_id)
         VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING ${CLAIM_ROW}`,
        values,
      );
    const readByKey = async (): Promise<PgQueueJobRow | null> => {
      const res = await this.db.query<PgQueueJobRow>(
        `SELECT ${CLAIM_ROW} FROM queue_jobs WHERE dedupe_key = $1`,
        [input.dedupeKey],
      );
      return res.rows[0] ?? null;
    };

    const inserted = await insert();
    if (inserted.rows[0]) return { row: inserted.rows[0], deduped: false };
    // Conflict path only happens when a dedupe key was supplied; a null key
    // never conflicts (Postgres NULLs are distinct), so rows[0] always exists
    // for internal rows. Guard anyway: re-read by key when present.
    if (!input.dedupeKey) throw new Error('enqueue lost its row without a dedupe conflict');

    const holder = await readByKey();
    if (!holder) throw new Error('enqueue lost its row without a dedupe conflict');
    // In flight (queued/running): the dedupe did its job — collapse two
    // publishes of one logical job onto one row.
    if (!isTerminalJobState(holder.state)) return { row: holder, deduped: true };

    // Terminal holder: it finished, so it must not block the next publish.
    // Also the recovery path for rows that reached terminal BEFORE the release
    // existed (no backfill needed — the key frees itself on first re-publish).
    await this.db.query(RELEASE_TERMINAL_DEDUPE_SQL, [input.dedupeKey]);
    const retried = await insert();
    if (retried.rows[0]) return { row: retried.rows[0], deduped: false };
    // Lost a concurrent race: another publisher got the key in between. Adopt
    // its row rather than minting a second job for the same logical work.
    const winner = await readByKey();
    if (winner) return { row: winner, deduped: true };
    throw new Error('enqueue lost its row without a dedupe conflict');
  }

  async getJob(jobId: string): Promise<PgQueueJobRow | null> {
    const res = await this.db.query<PgQueueJobRow>(
      `SELECT ${CLAIM_ROW} FROM queue_jobs WHERE job_id = $1`,
      [jobId],
    );
    return res.rows[0] ?? null;
  }

  // -- claim / lease ---------------------------------------------------------

  async claimBatch(kinds: string[], opts: ClaimOptions): Promise<PgQueueJobRow[]> {
    const q = buildClaimQuery(kinds, {
      batchSize: opts.batchSize,
      workerId: opts.workerId,
      leaseSeconds: opts.leaseSeconds ?? QUEUE_STUCK_AFTER_MINUTES * 60,
      refreshCoalesceMs: opts.refreshCoalesceMs ?? QUEUE_REFRESH_COALESCE_MS_DEFAULT,
    });
    const res = await this.db.query<PgQueueJobRow>(q.text, q.values);
    return res.rows;
  }

  /** Renew the lease on a long job the worker still owns. No D1 heartbeat. */
  async renewLease(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE queue_jobs
          SET lease_expires_at = now() + make_interval(secs => $3),
              updated_at = now()
        WHERE job_id = $1 AND state = 'running' AND claimed_by = $2`,
      [jobId, workerId, leaseSeconds],
    );
    return res.rowCount === 1;
  }

  /**
   * Give a claim back WITHOUT spending an attempt ("we did not start":
   * canonical-lock loss, no budget). Mirrors yieldJob in lib/jobs.ts.
   */
  async yieldJob(jobId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE queue_jobs
          SET state = 'queued',
              started_at = NULL,
              claimed_by = NULL,
              lease_expires_at = NULL,
              attempts = GREATEST(0, attempts - 1),
              available_at = now() + make_interval(secs => $2),
              last_error = $3,
              updated_at = now()
        WHERE job_id = $1`,
      [jobId, QUEUE_YIELD_COOLDOWN_MS / 1000, reason.slice(0, 1000)],
    );
  }

  // -- terminal transitions ----------------------------------------------------

  /**
   * `done`. Releases the dedupe key in the same statement: a finished job must
   * not keep `refresh:source:<id>` (or any other key) reserved, or the next
   * publish of the same logical job can never be created again (SLA-329).
   */
  async completeJob(jobId: string, analysisId: string | null, result?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE queue_jobs
          SET state = 'done',
              dedupe_key = NULL,
              analysis_id = COALESCE($2, analysis_id),
              result = COALESCE($3::jsonb, result),
              finished_at = now(),
              claimed_by = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              updated_at = now()
        WHERE job_id = $1`,
      [jobId, analysisId, result === undefined ? null : JSON.stringify(result)],
    );
  }

  /**
   * Record a failed attempt. Returns whether it was terminal. Terminal jobs
   * with an opId trigger exactly one refund via onTerminalRefund — the caller
   * (credits ledger) owns idempotency by `${opId}:fail`, same as the D1 path.
   * `terminal: true` forces terminal on the first attempt for deterministic
   * refusals (insufficient_credits, cap_breached, source_not_found...).
   */
  async failJob(
    jobId: string,
    message: string,
    opts?: { terminal?: boolean },
  ): Promise<{ terminal: boolean }> {
    const cur = await this.getJob(jobId);
    if (!cur) return { terminal: false };
    const terminal = opts?.terminal === true || cur.attempts >= cur.max_attempts;
    if (terminal) {
      await this.db.query(
        `UPDATE queue_jobs
            SET state = 'failed',
                dedupe_key = NULL,
                last_error = $2,
                finished_at = now(),
                claimed_by = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE job_id = $1`,
        [jobId, message.slice(0, 1000)],
      );
      if (cur.op_id && this.opts?.onTerminalRefund) {
        await this.opts.onTerminalRefund({
          workspaceId: cur.workspace_id,
          opId: cur.op_id,
          preAuthCredits: cur.pre_auth_credits ?? 0,
          kind: cur.kind,
        });
      }
    } else {
      await this.db.query(
        `UPDATE queue_jobs
            SET state = 'queued',
                last_error = $2,
                started_at = NULL,
                claimed_by = NULL,
                lease_expires_at = NULL,
                available_at = now() + make_interval(secs => $3),
                updated_at = now()
          WHERE job_id = $1`,
        [jobId, message.slice(0, 1000), queueBackoffMs(cur.attempts) / 1000],
      );
    }
    return { terminal };
  }

  /**
   * Queued cancellation (plan rev 4: queued only).
   * - queued -> cancelled (one refund when pre-authed), never claimable again;
   * - running -> { cancelled: false, reason: 'job_not_cancellable' };
   * - terminal -> idempotent { cancelled: false, reason: 'already_terminal' }.
   */
  async requestCancel(jobId: string): Promise<
    | { cancelled: true; row: PgQueueJobRow }
    | { cancelled: false; reason: 'job_not_cancellable' | 'already_terminal' | 'not_found' }
  > {
    const cur = await this.getJob(jobId);
    if (!cur) return { cancelled: false, reason: 'not_found' };
    if (cur.state === 'running') return { cancelled: false, reason: 'job_not_cancellable' };
    if (cur.state === 'done' || cur.state === 'failed' || cur.state === 'cancelled') {
      return { cancelled: false, reason: 'already_terminal' };
    }
    const res = await this.db.query<PgQueueJobRow>(
      `UPDATE queue_jobs
          SET state = 'cancelled',
              dedupe_key = NULL,
              cancel_requested_at = COALESCE(cancel_requested_at, now()),
              finished_at = now(),
              available_at = now(),
              claimed_by = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE job_id = $1 AND state = 'queued'
        RETURNING ${CLAIM_ROW}`,
      [jobId],
    );
    const row = res.rows[0];
    if (!row) return { cancelled: false, reason: 'already_terminal' };
    if (row.op_id && this.opts?.onTerminalRefund) {
      await this.opts.onTerminalRefund({
        workspaceId: row.workspace_id,
        opId: row.op_id,
        preAuthCredits: row.pre_auth_credits ?? 0,
        kind: row.kind,
      });
    }
    return { cancelled: true, row };
  }

  // -- recovery sweeps (bounded batches, worker-owned) --------------------------

  /**
   * Reclaim expired leases. Refresh jobs whose paid scrape already landed are
   * completed (never re-scraped) with a free rescore tail scheduled — the
   * scrape-landed check from the D1 path, injected via probes so this module
   * stays transport-only. Exhausted jobs fail with one idempotent refund.
   */
  async recoverExpiredLeases(batchSize = 200): Promise<SweepResult> {
    const res = await this.db.query<PgQueueJobRow>(
      `SELECT ${CLAIM_ROW} FROM queue_jobs
        WHERE state = 'running' AND lease_expires_at < now()
        ORDER BY lease_expires_at, job_id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    );
    let requeued = 0;
    let failed = 0;
    for (const job of res.rows) {
      if (job.kind === 'refresh' && this.opts?.isRefreshLanded) {
        try {
          if (await this.opts.isRefreshLanded(job)) {
            await this.completeJob(job.job_id, null);
            if (this.opts?.onRescoreTail) {
              await this.opts.onRescoreTail(job).catch(() => {});
            }
            requeued++;
            continue;
          }
        } catch {
          // Probe failure degrades to normal lease handling below.
        }
      }
      if (job.attempts >= job.max_attempts) {
        const done = await this.db.query(
          `UPDATE queue_jobs
              SET state = 'failed',
                  dedupe_key = NULL,
                  finished_at = now(),
                  claimed_by = NULL,
                  lease_expires_at = NULL,
                  last_error = 'worker lease expired; attempts exhausted',
                  updated_at = now()
            WHERE job_id = $1`,
          [job.job_id],
        );
        if (done.rowCount === 1) {
          failed++;
          if (job.op_id && this.opts?.onTerminalRefund) {
            await this.opts.onTerminalRefund({
              workspaceId: job.workspace_id,
              opId: job.op_id,
              preAuthCredits: job.pre_auth_credits ?? 0,
              kind: job.kind,
            }).catch(() => {});
          }
        }
      } else {
        const backoff = queueBackoffMs(job.attempts);
        const done = await this.db.query(
          `UPDATE queue_jobs
              SET state = 'queued',
                  claimed_by = NULL,
                  lease_expires_at = NULL,
                  started_at = NULL,
                  available_at = now() + make_interval(secs => $2),
                  last_error = 'worker lease expired; requeued',
                  updated_at = now()
            WHERE job_id = $1`,
          [job.job_id, backoff / 1000],
        );
        if (done.rowCount === 1) requeued++;
      }
    }
    return { requeued, failed, more: res.rows.length >= batchSize };
  }

  /** Fail never-claimed queued rows (mirrors failAbandonedQueuedJobs). */
  async failAbandonedQueued(
    olderThanMinutes = QUEUE_ABANDONED_AFTER_MINUTES,
    batchSize = 200,
  ): Promise<{ failed: number; more: boolean }> {
    const res = await this.db.query<PgQueueJobRow>(
      `SELECT ${CLAIM_ROW} FROM queue_jobs
        WHERE state = 'queued'
          AND created_at < now() - make_interval(secs => $1)
          AND started_at IS NULL
          AND (available_at IS NULL OR available_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [olderThanMinutes * 60, batchSize],
    );
    let failed = 0;
    for (const job of res.rows) {
      const done = await this.db.query(
        `UPDATE queue_jobs
            SET state = 'failed',
                dedupe_key = NULL,
                finished_at = now(),
                last_error = 'Never claimed by any worker — the queue is not draining.',
                updated_at = now()
          WHERE job_id = $1 AND state = 'queued' AND started_at IS NULL`,
        [job.job_id],
      );
      if (done.rowCount === 1) {
        failed++;
        if (job.op_id && this.opts?.onTerminalRefund) {
          await this.opts.onTerminalRefund({
            workspaceId: job.workspace_id,
            opId: job.op_id,
            preAuthCredits: job.pre_auth_credits ?? 0,
            kind: job.kind,
          }).catch(() => {});
        }
      }
    }
    return { failed, more: res.rows.length >= batchSize };
  }

  // -- canonical scrape locks ----------------------------------------------------

  /**
   * Take the lease for one canonical query, or fail immediately. Single
   * UPSERT is the atomic part: exactly one caller wins, losers get no row.
   */
  async acquireCanonicalLock(
    key: string,
    owner: string,
    ttlMs = QUEUE_CANONICAL_LOCK_TTL_MS,
  ): Promise<boolean> {
    const rows = await this.db.query<{ holder_id: string }>(
      `INSERT INTO canonical_scrape_locks (canonical_key, holder_id, lease_expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (canonical_key) DO UPDATE
          SET holder_id = EXCLUDED.holder_id,
              lease_expires_at = EXCLUDED.lease_expires_at,
              updated_at = now()
        WHERE canonical_scrape_locks.lease_expires_at < now()
       RETURNING holder_id`,
      [key, owner, ttlMs / 1000],
    );
    return rows.rows[0]?.holder_id === owner;
  }

  /** Release a lease we own; a lease we no longer own is left alone. */
  async releaseCanonicalLock(key: string, owner: string): Promise<void> {
    await this.db.query(
      `DELETE FROM canonical_scrape_locks WHERE canonical_key = $1 AND holder_id = $2`,
      [key, owner],
    );
  }

  // -- producer nonces --------------------------------------------------------------

  /**
   * Atomically consume a nonce. True = first use; false = replay (the caller
   * returns 409 replay_detected and must NOT enqueue). Expired rows are
   * pruned by pruneExpiredNonces / queue_prune_retention.
   */
  async consumeNonce(keyId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO producer_nonces (key_id, nonce, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key_id, nonce) DO NOTHING`,
      [keyId, nonce, expiresAt],
    );
    return res.rowCount === 1;
  }

  async pruneExpiredNonces(): Promise<number> {
    const res = await this.db.query(`DELETE FROM producer_nonces WHERE expires_at < now()`);
    return res.rowCount;
  }

  // -- logs / retention -----------------------------------------------------------------

  async recordLog(
    jobId: string,
    workerId: string | null,
    level: string,
    event: string,
    detail?: unknown,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queue_job_logs (job_id, worker_id, level, event, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [jobId, workerId, level, event, detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  async pruneRetention(batchLimit = 1000): Promise<{ prunedJobs: number; prunedNonces: number; prunedLogs: number }> {
    const res = await this.db.query<{ pruned_jobs: number; pruned_nonces: number; pruned_logs: number }>(
      `SELECT * FROM queue_prune_retention($1)`,
      [batchLimit],
    );
    const r = res.rows[0] ?? { pruned_jobs: 0, pruned_nonces: 0, pruned_logs: 0 };
    return { prunedJobs: r.pruned_jobs, prunedNonces: r.pruned_nonces, prunedLogs: r.pruned_logs };
  }
}
