// ---------------------------------------------------------------------------
// PG queue contract — shared types, validation, and D1-shape serialization.
//
// Plan rev 4 (SLA-10): the PG claim returns a MediaJobRow-equivalent object;
// processClaimedJob (src/worker/process-job.ts) receives the same shape and
// is NOT forked. This module is dependency-free (no db, no zod) so the
// queue-api, the worker adapter, and unit tests all share one definition.
//
// Numeric policy (backoff/cooldown/lease) deliberately mirrors src/lib/jobs.ts:
// requeueBackoffMs, YIELD_COOLDOWN_MS, STUCK_AFTER_MINUTES,
// QUEUED_ABANDONED_AFTER_MINUTES, MAX_ATTEMPTS. src/queue/compat.test.ts pins
// the mirroring — if lib/jobs.ts changes, that test fails first.
// ---------------------------------------------------------------------------

/** Job kinds, exactly the D1 vocabulary. No numeric priority is introduced. */
export const QUEUE_KINDS = [
  'fetch',
  'analyze',
  'recreate',
  'thumb',
  'discover',
  'rescore',
  'refresh',
] as const;

export type QueueJobKind = (typeof QUEUE_KINDS)[number];

/** PG queue states. Uses D1's `done` (not `completed`) for compatibility. */
export const QUEUE_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

export type QueueJobState = (typeof QUEUE_STATES)[number];

/**
 * States a job never leaves. A terminal job must stop occupying its dedupe
 * key: `queue_jobs.dedupe_key` is UNIQUE, so a terminal holder turns every
 * later publish of the same logical job into a silent no-op (SLA-329 — a
 * source's second refresh deduped onto a four-day-old `done` row). Dedupe is
 * about work IN FLIGHT, not work that once existed.
 */
export const QUEUE_TERMINAL_STATES: readonly QueueJobState[] = ['done', 'failed', 'cancelled'];

export function isTerminalJobState(state: string): boolean {
  return (QUEUE_TERMINAL_STATES as readonly string[]).includes(state);
}

/** SQL literal list of the terminal states (single source for pg.ts). */
export const QUEUE_TERMINAL_STATE_SQL = QUEUE_TERMINAL_STATES.map((s) => `'${s}'`).join(', ');

/** Give up after this many attempts (mirrors MAX_ATTEMPTS in lib/jobs.ts). */
export const QUEUE_MAX_ATTEMPTS = 3;

/** First retry waits 2 min, later retries 8 min (mirrors requeueBackoffMs). */
export function queueBackoffMs(attempts: number): number {
  return (attempts >= 2 ? 8 : 2) * 60_000;
}

/** Yielded jobs park 60s (mirrors YIELD_COOLDOWN_MS — "we did not start"). */
export const QUEUE_YIELD_COOLDOWN_MS = 60_000;

/** Running lease presumed abandoned after this (mirrors STUCK_AFTER_MINUTES). */
export const QUEUE_STUCK_AFTER_MINUTES = 15;

/** Never-claimed queued rows fail after this (mirrors QUEUED_ABANDONED...). */
export const QUEUE_ABANDONED_AFTER_MINUTES = 90;

/** Default refresh coalescing hold (mirrors refreshCoalesceMs default). */
export const QUEUE_REFRESH_COALESCE_MS_DEFAULT = 30_000;

/** Canonical scrape lease TTL (mirrors CANONICAL_LOCK_TTL_MS). */
export const QUEUE_CANONICAL_LOCK_TTL_MS = 10 * 60_000;

/** Producer body cap: 64 KiB. */
export const QUEUE_BODY_MAX_BYTES = 64 * 1024;

/** Auth timestamp skew: ±5 minutes. */
export const QUEUE_AUTH_SKEW_SECONDS = 5 * 60;

/** Producer nonce lifetime: timestamp + 10 minutes. */
export const QUEUE_NONCE_TTL_SECONDS = 10 * 60;

/** Internal kind allowlist — same regex as claimNextJobs in lib/jobs.ts. */
export function normalizeKindList(kinds: string[]): QueueJobKind[] {
  const out: QueueJobKind[] = [];
  const seen = new Set<string>();
  for (const k of kinds) {
    if (!/^[a-z][a-z_]*$/.test(k)) continue;
    if (!(QUEUE_KINDS as readonly string[]).includes(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k as QueueJobKind);
  }
  return out;
}

/**
 * expandWorkerKinds parity: refresh pulls in discover (proxy provider only),
 * analyze pulls in recreate. Kept here so the PG claim builds the same
 * effective kind list without importing the worker runtime.
 */
export function expandQueueKinds(kinds: string[], scraperProvider?: string): QueueJobKind[] {
  const provider = (scraperProvider ?? process.env.SCRAPER_PROVIDER ?? '').trim().toLowerCase();
  let out = normalizeKindList(kinds);
  if (out.includes('refresh') && !out.includes('discover') && provider === 'proxy') {
    out = [...out, 'discover'];
  }
  if (out.includes('analyze') && !out.includes('recreate')) {
    out = [...out, 'recreate'];
  }
  return out;
}

/** One row of queue_jobs as returned by the adapter (snake_case, PG types). */
export interface PgQueueJobRow {
  job_id: string;
  dedupe_key: string | null;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  claimed_by: string | null;
  lease_expires_at: string | Date | null;
  workspace_id: string;
  video_id: string | null;
  source_id: string | null;
  payload: unknown;
  result: unknown;
  op_id: string | null;
  pre_auth_credits: number | null;
  deadline_at: string | Date | null;
  analysis_id: string | null;
  available_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  last_error: string | null;
  cancel_requested_at: string | Date | null;
  d1_synced_at: string | Date | null;
  d1_job_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Minimal MediaJobRow field set processClaimedJob reads (see lib/jobs.ts). */
export interface MediaJobShape {
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
  availableAt: Date | null;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Serialize a PG row into the exact MediaJobRow shape processClaimedJob
 * expects. `status` carries the PG state verbatim (cancelled included —
 * the adapter never claims cancelled rows, so the processor never sees it).
 */
export function toMediaJobShape(row: PgQueueJobRow): MediaJobShape {
  const payloadJson =
    typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload ?? {});
  return {
    id: row.job_id,
    workspaceId: row.workspace_id,
    videoId: row.video_id,
    sourceId: row.source_id,
    deadlineAt: toDate(row.deadline_at),
    preAuthCredits: row.pre_auth_credits,
    kind: row.kind,
    status: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    payloadJson,
    opId: row.op_id,
    analysisId: row.analysis_id,
    createdAt: toDate(row.created_at) ?? new Date(0),
    startedAt: toDate(row.started_at),
    finishedAt: toDate(row.finished_at),
    availableAt: toDate(row.available_at),
  };
}

/**
 * Target invariants (plan rev 4 §Producer API, corrected for rescore):
 * - discover: videoId = null AND sourceId = null
 * - refresh, rescore: sourceId set AND videoId = null. Rescore is a
 *   source-scoped tail of a refresh (enqueueRescoreJob takes sourceId, never
 *   videoId — every call site in tools/baselines, lib/refresh,
 *   lib/sources-service, and the reclaim tail proves it). The plan text lists
 *   rescore under "video-only kinds", which would 422 the rescore canary.
 * - all others: videoId set AND sourceId = null
 * Returns an error string, or null when valid.
 */
export function validateJobTargets(
  kind: string,
  videoId: string | null,
  sourceId: string | null,
): string | null {
  if (kind === 'discover') {
    if (videoId != null || sourceId != null) return 'discover requires videoId=null and sourceId=null';
    return null;
  }
  if (kind === 'refresh' || kind === 'rescore') {
    if (sourceId == null || videoId != null) return `${kind} requires sourceId and forbids videoId`;
    return null;
  }
  if (videoId == null || sourceId != null) return `${kind} requires videoId and forbids sourceId`;
  return null;
}

/** Deterministic dedupe key convention for externally enqueued jobs. */
export function dedupeKeyFor(
  kind: string,
  videoId: string | null,
  sourceId: string | null,
): string {
  if (kind === 'refresh') return `refresh:source:${sourceId}`;
  if (kind === 'discover') return '';
  if (sourceId) return `${kind}:source:${sourceId}`;
  return `${kind}:video:${videoId}`;
}

/** D1 fallback reconciliation key: never mints a second billing operation. */
export function fallbackDedupeKey(d1MediaJobId: string): string {
  return `d1:${d1MediaJobId}`;
}

// ---------------------------------------------------------------------------
// Error envelope — every non-2xx queue-api response uses this shape.
// ---------------------------------------------------------------------------

export type QueueErrorCode =
  | 'unauthenticated'
  | 'replay_detected'
  | 'body_too_large'
  | 'rate_limited'
  | 'invalid_job'
  | 'invalid_target'
  | 'job_not_cancellable'
  | 'already_terminal'
  | 'not_found'
  | 'forbidden'
  | 'queue_unavailable'
  | 'internal_error';

export interface QueueErrorBody {
  error: {
    code: QueueErrorCode;
    message: string;
    retryable: boolean;
    jobId: string | null;
  };
}

const RETRYABLE_CODES: ReadonlySet<QueueErrorCode> = new Set([
  'rate_limited',
  'queue_unavailable',
  'internal_error',
]);

export function queueError(
  code: QueueErrorCode,
  message: string,
  jobId: string | null = null,
): QueueErrorBody {
  return { error: { code, message, retryable: RETRYABLE_CODES.has(code), jobId } };
}

/** Queue-safe GET fields (plan rev 4 §Status and cancellation). */
export interface QueueJobStatus {
  jobId: string;
  kind: string;
  state: string;
  attempts: number;
  availableAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  lastError: string | null;
}

function iso(v: string | Date | null | undefined): string | null {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

export function toJobStatus(row: PgQueueJobRow): QueueJobStatus {
  return {
    jobId: row.job_id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    availableAt: iso(row.available_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    deadlineAt: iso(row.deadline_at),
    lastError: row.last_error,
  };
}
