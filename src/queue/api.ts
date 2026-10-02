// ---------------------------------------------------------------------------
// queue-api — signed producer HTTP boundary (framework-agnostic core).
//
// Routes (exact canonical paths — no query string, no trailing slash):
//   GET  /healthz                  unauthenticated liveness
//   GET  /readyz                   unauthenticated readiness (PG ping)
//   POST /v1/jobs                  enqueue (202, deduped included)
//   GET  /v1/jobs/{jobId}          queue-safe status fields only
//   POST /v1/jobs/{jobId}/cancel   queued -> cancelled (one refund)
//
// Ordering per request: raw-body preservation -> auth (timestamp+signature)
// -> rate/body limits -> Zod validation -> nonce commit with the business
// transaction. The service reads the RAW body before JSON parsing; no generic
// JSON middleware may sit in front of the signed routes (see server.ts).
//
// Observability: every terminal response, including each 429 gate, reports
// itself once through deps.onOutcome with the status the producer actually
// got (SLA-350). Rejections used to return before the only report call, which
// lived in the 202 branch with 202 hardcoded — so every rejects_total series
// was unreachable from HTTP.
//
// Nonce rule: the nonce is committed only when the business transaction
// succeeds. Enqueue inserts it atomically alongside the job row. For
// non-enqueueing lookups (GET/cancel) a transient failure AFTER a successful
// lookup may leave the nonce consumed — documented here as acceptable: the
// producer retries with a fresh nonce and the lookup is side-effect free.
// A rejected request never enqueues.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  keyMayAccessWorkspace,
  verifyAuth,
  type KeyStore,
} from './auth.js';
import {
  QUEUE_AUTH_SKEW_SECONDS,
  QUEUE_BODY_MAX_BYTES,
  QUEUE_KINDS,
  QUEUE_NONCE_TTL_SECONDS,
  dedupeKeyFor,
  queueError,
  toJobStatus,
  validateJobTargets,
} from './contract.js';
import type { RateLimitGate } from './metrics.js';
import { PgQueue } from './pg.js';

// -- validation ---------------------------------------------------------------

const enqueueSchema = z.object({
  kind: z.enum(QUEUE_KINDS),
  workspaceId: z.string().min(1).max(256),
  videoId: z.string().min(1).max(256).nullable(),
  sourceId: z.string().min(1).max(256).nullable(),
  dedupeKey: z.string().min(1).max(512),
  deadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  credits: z
    .object({
      opId: z.string().min(1).max(256),
      preAuthCredits: z.number().int().min(0).max(1_000_000),
    })
    .nullable()
    .optional(),
  // Pre-allocated D1 projection id (SLA-16 Phase 2b): stored as d1_job_id so
  // the D1 compatibility row and the PG row share one id. Optional — older
  // producers omit it and the server behaves exactly as before.
  d1JobId: z.string().uuid().nullable().optional(),
});

export type EnqueueBody = z.infer<typeof enqueueSchema>;

// -- rate limiting ------------------------------------------------------------

/** Fixed-window counters. Traefik adds an outer layer; this is the app gate. */
export interface RateLimits {
  /** Per key: 120 burst / 60 sustained per minute. */
  perKeyPerMinute: number;
  /** Per workspace: 30 publishes/minute. */
  perWorkspacePerMinute: number;
  /** Per kind+workspace: 10 publishes/minute. */
  perKindWorkspacePerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  perKeyPerMinute: 120,
  perWorkspacePerMinute: 30,
  perKindWorkspacePerMinute: 10,
};

export interface RateLimiter {
  /** Returns null when allowed, or retry-after seconds when limited. */
  take(key: string, limit: number, windowSeconds?: number): number | null;
}

export function memoryRateLimiter(nowMs = () => Date.now()): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, limit, windowSeconds = 60) {
      const now = nowMs();
      const cutoff = now - windowSeconds * 1000;
      const arr = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (arr.length >= limit) {
        hits.set(key, arr);
        const retryAfter = Math.max(1, Math.ceil((arr[0] + windowSeconds * 1000 - now) / 1000));
        return retryAfter;
      }
      arr.push(now);
      hits.set(key, arr);
      return null;
    },
  };
}

// -- request/response surface ----------------------------------------------------

export interface QueueHttpRequest {
  method: string;
  /** Path WITHOUT query string, as seen on the wire (percent-decoded once). */
  path: string;
  /** Raw query string ('' when absent) — signed POSTs must not carry one. */
  query: string;
  headers: Record<string, string | undefined>;
  /** Exact raw bytes, preserved end to end for HMAC. */
  rawBody: Uint8Array;
}

export interface QueueHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface QueueApiDeps {
  queue: PgQueue;
  keys: KeyStore;
  limiter: RateLimiter;
  limits: RateLimits;
  /** PG liveness probe for /readyz. */
  ping(): Promise<boolean>;
  nowSeconds(): number;
  /**
   * Fires once per request, for EVERY terminal response — not just accepted
   * publishes. It is the queue-api's own instrument: server.ts wires it to
   * recordApiEvent, whose 401/409/413/422/429/5xx branches are all reachable
   * only from here (SLA-350).
   *
   * `gate` is set on a 429 and names the limiter that refused, so
   * cause="rate_limit" can be split into per_key / per_workspace /
   * per_kind_workspace instead of one untunable number.
   */
  onOutcome?: (info: {
    keyId: string;
    kind: string;
    workspaceId: string;
    deduped: boolean;
    latencyMs: number;
    status: number;
    gate?: RateLimitGate;
  }) => void;
}

function json(status: number, value: unknown, extraHeaders?: Record<string, string>): QueueHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(value),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleQueueRequest(
  req: QueueHttpRequest,
  deps: QueueApiDeps,
): Promise<QueueHttpResponse> {
  const startedAt = Date.now();
  const method = req.method.toUpperCase();

  // -- outcome reporting (SLA-350) ------------------------------------------------
  // Every terminal response below goes through respond(), which reports the
  // status the producer actually received to deps.onOutcome BEFORE returning.
  //
  // This used to be a single deps.onPublish call inside the 202 branch with
  // `status: 202` hardcoded. All three 429 gates returned before reaching it,
  // so recordApiEvent's `status === 429` branch was dead code from the HTTP
  // path: slashloop_queue_api_rejects_total{cause="rate_limit"} rendered a
  // permanent 0 and QueueApiRejectsSpike could never fire on rate limiting.
  // 401/409/413/422/5xx were unreachable the same way.
  //
  // The context fields are filled in as the request reveals them; early
  // rejections legitimately report an empty keyId/kind/workspaceId.
  let keyId = '';
  let kind = '';
  let workspaceId = '';
  let deduped = false;
  /** Set only on the 429 branches, immediately before returning. */
  let gate: RateLimitGate | undefined;

  const respond = (
    status: number,
    value: unknown,
    extraHeaders?: Record<string, string>,
  ): QueueHttpResponse => {
    deps.onOutcome?.({
      keyId,
      kind,
      workspaceId,
      deduped,
      latencyMs: Date.now() - startedAt,
      status,
      ...(gate ? { gate } : {}),
    });
    return json(status, value, extraHeaders);
  };

  // -- unauthenticated health ---------------------------------------------------
  // Reported by the scrape, not by the request counter — health checks are not
  // publishes and must not move a producer-facing series.
  if (method === 'GET' && req.path === '/healthz' && !req.query) {
    return json(200, { ok: true });
  }
  if (method === 'GET' && req.path === '/readyz' && !req.query) {
    try {
      const ready = await deps.ping();
      return ready ? json(200, { ok: true }) : json(503, queueError('queue_unavailable', 'queue-db unreachable'));
    } catch {
      return json(503, queueError('queue_unavailable', 'queue-db unreachable'));
    }
  }

  // -- signed route matching (exact; trailing slashes + unknowns reject) -------
  let route: 'enqueue' | 'status' | 'cancel' | null = null;
  let jobId: string | null = null;
  if (method === 'POST' && req.path === '/v1/jobs') {
    route = 'enqueue';
  } else if (req.path.startsWith('/v1/jobs/')) {
    const rest = req.path.slice('/v1/jobs/'.length);
    if (method === 'GET' && UUID_RE.test(rest)) {
      route = 'status';
      jobId = rest;
    } else if (method === 'POST' && rest.endsWith('/cancel')) {
      const id = rest.slice(0, -'/cancel'.length);
      if (UUID_RE.test(id)) {
        route = 'cancel';
        jobId = id;
      }
    }
  }
  if (!route) {
    // Unknown path/trailing slash: 404 before verification (no oracle).
    return respond(404, queueError('not_found', 'unknown path'));
  }

  // Signed POSTs must not carry a query string (canonical path is exact).
  if (method === 'POST' && req.query) {
    return respond(401, queueError('unauthenticated', 'query strings are not accepted on signed routes'));
  }

  // -- body cap (before auth: oversized bodies never reach verification) --------
  if (req.rawBody.length > QUEUE_BODY_MAX_BYTES) {
    return respond(413, queueError('body_too_large', `body exceeds ${QUEUE_BODY_MAX_BYTES} bytes`));
  }

  // -- auth (before business validation) -----------------------------------------
  const canonicalPath = route === 'enqueue' ? '/v1/jobs' : `/v1/jobs/${jobId}${route === 'cancel' ? '/cancel' : ''}`;
  const auth = verifyAuth(req.headers, method, canonicalPath, req.rawBody, deps.keys, deps.nowSeconds());
  if (!auth.ok) {
    return respond(401, queueError('unauthenticated', `bad auth: ${auth.reason}`));
  }
  keyId = auth.key.keyId;

  // -- per-key rate limit ----------------------------------------------------------
  const keyRetry = deps.limiter.take(`key:${auth.key.keyId}`, deps.limits.perKeyPerMinute);
  if (keyRetry != null) {
    gate = 'per_key';
    return respond(429, queueError('rate_limited', 'per-key rate limit exceeded'), {
      'retry-after': String(keyRetry),
    });
  }

  if (route === 'status') {
    const row = await deps.queue.getJob(jobId!);
    if (!row) return respond(404, queueError('not_found', 'job not found', jobId));
    if (!keyMayAccessWorkspace(auth.key, row.workspace_id)) {
      return respond(403, queueError('forbidden', 'key is not authorized for this workspace', jobId));
    }
    // Nonce commit for a successful side-effect-free lookup.
    await deps.queue
      .consumeNonce(auth.key.keyId, auth.nonce, nonceExpiry(deps.nowSeconds()))
      .catch(() => {});
    return respond(200, toJobStatus(row));
  }

  if (route === 'cancel') {
    const row = await deps.queue.getJob(jobId!);
    if (!row) return respond(404, queueError('not_found', 'job not found', jobId));
    if (!keyMayAccessWorkspace(auth.key, row.workspace_id)) {
      return respond(403, queueError('forbidden', 'key is not authorized for this workspace', jobId));
    }
    const outcome = await deps.queue.requestCancel(jobId!);
    // Successful terminal transition commits the nonce.
    if (outcome.cancelled) {
      await deps.queue
        .consumeNonce(auth.key.keyId, auth.nonce, nonceExpiry(deps.nowSeconds()))
        .catch(() => {});
      return respond(200, { jobId, state: 'cancelled', acceptedAt: new Date().toISOString() });
    }
    if (outcome.reason === 'job_not_cancellable') {
      return respond(409, queueError('job_not_cancellable', 'only queued jobs can be cancelled', jobId));
    }
    // already_terminal: idempotent — return current state with 200 (consistent
    // choice per plan rev 4: implement ONE behavior; this is it).
    await deps.queue
      .consumeNonce(auth.key.keyId, auth.nonce, nonceExpiry(deps.nowSeconds()))
      .catch(() => {});
    const current = await deps.queue.getJob(jobId!);
    return respond(200, {
      jobId,
      state: current?.state ?? 'unknown',
      acceptedAt: new Date().toISOString(),
    });
  }

  // -- enqueue ----------------------------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(req.rawBody).toString('utf8'));
  } catch {
    return respond(422, queueError('invalid_job', 'body is not valid JSON'));
  }
  const zod = enqueueSchema.safeParse(parsed);
  if (!zod.success) {
    return respond(422, queueError('invalid_job', `invalid job: ${zod.error.issues[0]?.message ?? 'validation failed'}`));
  }
  const body = zod.data;
  kind = body.kind;
  workspaceId = body.workspaceId;

  const targetError = validateJobTargets(body.kind, body.videoId, body.sourceId);
  if (targetError) {
    return respond(422, queueError('invalid_target', targetError));
  }

  // Per-workspace and per-kind+workspace publish limits (after validation so
  // invalid bodies do not burn the workspace budget).
  const wsRetry = deps.limiter.take(`ws:${body.workspaceId}`, deps.limits.perWorkspacePerMinute);
  if (wsRetry != null) {
    gate = 'per_workspace';
    return respond(429, queueError('rate_limited', 'per-workspace publish limit exceeded'), {
      'retry-after': String(wsRetry),
    });
  }
  const kindRetry = deps.limiter.take(
    `kind:${body.kind}:${body.workspaceId}`,
    deps.limits.perKindWorkspacePerMinute,
  );
  if (kindRetry != null) {
    gate = 'per_kind_workspace';
    return respond(429, queueError('rate_limited', 'per-kind publish limit exceeded'), {
      'retry-after': String(kindRetry),
    });
  }

  // Nonce + enqueue atomically-ish: consumeNonce first (unique constraint is
  // the atomic arbiter — a racing duplicate gets rowCount 0 and a 409, and
  // never enqueues). If enqueue then fails transiently, the nonce stays
  // consumed and the producer retries with a FRESH nonce + the SAME dedupe
  // key. While the first job is still in flight the dedupe key replays the
  // retry onto the same row; once it is terminal the key is released
  // (SLA-329), so the retry becomes a new job instead of a permanent no-op.
  const nonceOk = await deps.queue.consumeNonce(
    auth.key.keyId,
    auth.nonce,
    nonceExpiry(deps.nowSeconds(), auth.timestamp),
  );
  if (!nonceOk) {
    return respond(409, queueError('replay_detected', 'nonce already used'));
  }

  let deadlineAt: Date | null = null;
  if (body.deadlineAt) {
    deadlineAt = new Date(body.deadlineAt);
  }
  // deadlineAt/opId/preAuthCredits pass through VERBATIM — the producer never
  // mints replacement billing identities.
  const dedupeKey = body.dedupeKey || dedupeKeyFor(body.kind, body.videoId, body.sourceId);
  try {
    const { row, deduped: resolvedDeduped } = await deps.queue.enqueue({
      kind: body.kind,
      workspaceId: body.workspaceId,
      videoId: body.videoId,
      sourceId: body.sourceId,
      dedupeKey,
      deadlineAt,
      payload: body.payload ?? {},
      opId: body.credits?.opId ?? null,
      preAuthCredits: body.credits?.preAuthCredits ?? null,
      d1JobId: body.d1JobId ?? null,
    });
    deduped = resolvedDeduped;
    return respond(202, {
      jobId: row.job_id,
      // The REAL state of the row this publish resolved to. Hardcoding
      // 'queued' here is what let a dedupe onto an already-terminal job read
      // as freshly queued work at every call site (SLA-329).
      state: row.state,
      deduped: resolvedDeduped,
      acceptedAt: new Date().toISOString(),
    });
  } catch (err) {
    return respond(500, queueError('internal_error', `enqueue failed: ${(err as Error).message}`));
  }
}

function nonceExpiry(nowSeconds: number, requestTimestamp?: string): Date {
  // Nonce lives timestamp + 10 min; fall back to now + 10 min when the request
  // timestamp is unavailable (lookup paths reuse the same window).
  const base = requestTimestamp && /^\d+$/.test(requestTimestamp) ? Number(requestTimestamp) : nowSeconds;
  return new Date((base + QUEUE_NONCE_TTL_SECONDS) * 1000);
}

/** Skew constant re-export for server wiring/tests. */
export const AUTH_SKEW_SECONDS = QUEUE_AUTH_SKEW_SECONDS;
