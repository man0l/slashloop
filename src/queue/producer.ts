// ---------------------------------------------------------------------------
// PG producer client — signed HTTPS publish to queue-api (SLA-16 Phase 2b).
//
// Runtime-safe: WebCrypto + fetch only, no node: imports, so the same client
// runs on Vercel/Node, Bun/VPS, and the Cloudflare Worker (all of which call
// lib/jobs.ts enqueue*Job). The canonical HMAC format is reimplemented here
// (5 lines) instead of importing auth.ts, which needs node:crypto for the
// server's timing-safe verify — producer.test.ts pins the two against each
// other with a sign/verify roundtrip.
//
// Auth envelope (plan rev 4 §Authentication):
//   POST {baseUrl}/v1/jobs (exact path, never a query string)
//   X-SLQ-Key-Id / X-SLQ-Timestamp / X-SLQ-Nonce / X-SLQ-Signature
//   canonical = METHOD\n\nPATH\n\nTIMESTAMP\n\nNONCE\n\nSHA256_HEX(raw_body)
// Secrets are never logged (this module has no logging at all).
//
// A 429 is answered, not thrown: the `retry-after` header is waited out
// inside publishJobHttp (SLA-349), bounded by DEFAULT_RATE_LIMIT_WAIT_BUDGET_MS.
// ---------------------------------------------------------------------------

export interface ProducerConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
  /** Per-request timeout ms (default 10s — queue-api is local to its VPS). */
  timeoutMs: number;
  /**
   * Per-publish budget for waiting out `429 retry-after`, in ms.
   * 0 disables waiting (a 429 throws, so the row parks) — set it on a
   * deployment that must not hold a caller open, e.g. the Vercel MCP
   * function whose maxDuration is 60s. See
   * QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS.
   */
  rateLimitWaitBudgetMs?: number;
}

export const DEFAULT_PRODUCER_TIMEOUT_MS = 10_000;

/**
 * Env: QUEUE_API_URL (default https://queue.slashloop.dev), key id/secret.
 * QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS caps the `429 retry-after` wait per
 * publish; 0 turns the wait off for this deployment (park on 429 instead).
 */
export function loadProducerConfig(env: NodeJS.ProcessEnv = process.env): ProducerConfig | null {
  const baseUrl = (env.QUEUE_API_URL ?? 'https://queue.slashloop.dev').trim().replace(/\/+$/, '');
  const keyId = (env.QUEUE_API_KEY_ID ?? '').trim();
  const secret = (env.QUEUE_API_KEY_SECRET ?? '').trim();
  if (!baseUrl || !keyId || !secret) return null;
  const timeoutRaw = Number(env.QUEUE_API_TIMEOUT_MS ?? DEFAULT_PRODUCER_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_PRODUCER_TIMEOUT_MS;
  const budgetRaw = (env.QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS ?? '').trim();
  const budgetNum = Number(budgetRaw);
  const rateLimitWaitBudgetMs =
    budgetRaw !== '' && Number.isFinite(budgetNum) && budgetNum >= 0 ? Math.floor(budgetNum) : undefined;
  return { baseUrl, keyId, secret, timeoutMs, rateLimitWaitBudgetMs };
}

export interface PublishBody {
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  dedupeKey: string;
  deadlineAt: string | null;
  payload: Record<string, unknown>;
  credits?: { opId: string; preAuthCredits: number } | null;
  /** Pre-allocated D1 projection id — PG stores it as d1_job_id (1:1 link). */
  d1JobId?: string | null;
}

export interface PublishAccepted {
  pgJobId: string;
  deduped: boolean;
}

export type ProducerErrorCode =
  | 'unauthenticated'
  | 'replay_detected'
  | 'rate_limited'
  | 'invalid_job'
  | 'queue_unavailable'
  | 'internal_error'
  | 'network_error';

export class ProducerHttpError extends Error {
  readonly code: ProducerErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  constructor(
    code: ProducerErrorCode,
    message: string,
    opts: { status?: number | null; retryable: boolean; retryAfterSeconds?: number | null } = {
      retryable: false,
    },
  ) {
    super(message);
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

/**
 * `429 retry-after` is a request to wait, not a failure (SLA-349). Before
 * this the header was parsed into retryAfterSeconds and then never read, so
 * the wait the server named happened nowhere: the publish threw, the row was
 * parked as fallback_d1 / queued_remote, and the job went invisible to every
 * claimer until the reconciler swept it — up to a full
 * WORKER_RECLAIM_INTERVAL_MS (default 5 min) instead of the seconds the
 * response already said. Measured on 2026-10-01: 34 rescore publishes in
 * 9.5s turned into an 8m08s staircase.
 *
 * The default assumes queue-api's own limiter window: api.ts
 * DEFAULT_RATE_LIMITS are all per-minute and memoryRateLimiter's window
 * default is 60s, so an absent/garbage header means "come back in a minute".
 */
export const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * Ceiling on the total time one publish may spend waiting out 429s.
 *
 * One limiter window plus slack: a single retry-after that fits is honoured,
 * and that wait then unblocks a whole window's worth of publishes in the
 * calling fan-out loop, so a burst amortizes instead of stalling. The slack
 * also covers the SLA-354 jitter: the server's longest sane retry-after is
 * one 60s window, and 60s + 3s jitter still fits in 65s. A longer ask (or a
 * second 429 inside the same call) does not fit and the caller keeps today's
 * behaviour — park the row and let the reconciler drain it — rather than
 * holding a request open for an unbounded time. In particular a
 * bogus/absurd retry-after cannot pin a caller for as long as it asks for.
 */
export const DEFAULT_RATE_LIMIT_WAIT_BUDGET_MS = 65_000;

/**
 * Random spread added to each `429 retry-after` wait (SLA-354), in ms.
 *
 * queue-api's limiter (api.ts memoryRateLimiter) is a SLIDING window: capacity
 * frees continuously as each recorded hit ages out, and retry-after is the time
 * until the oldest hit expires. Publishers that tripped it at the same moment
 * therefore all get the same retry-after and retry at the same instant, where
 * only the slots expiring right then are free — the rest re-429 or park. With
 * WORKER_CONCURRENCY > 1 and one worker container per kind, two refreshes of
 * one workspace re-burst together. A small spread de-aligns the retries so each
 * lands on a different slice of freed capacity.
 *
 * Bounded well under the budget slack: the server's longest sane retry-after
 * is one window (60s), 60s + 3s still fits inside the default 65s budget, so
 * the jitter never turns a wait that would have fit into a park.
 *
 * Operators: the jitter counts against QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS, so
 * that budget needs window + this max (3s) of headroom to honour a legal
 * full-window retry-after. Set to 60000 it would turn almost every full-window
 * wait into a park (retry-after 60s + any jitter > 0 exceeds it) — strictly
 * worse than before the jitter existed. Likewise two 30s waits in one publish
 * only fit when their jitters sum to <= 5s of the 65s default.
 */
export const DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS = 3_000;

/**
 * True when `err` is a queue-api rate limit, including one rethrown through
 * QueuePublisher's wrap (which carries the producer code as `producerCode`).
 * Without that, a caller could only tell "this was a rate limit" apart from
 * "PG really failed" by matching the message string.
 */
export function isRateLimitedError(err: unknown): boolean {
  if (err instanceof ProducerHttpError) return err.code === 'rate_limited';
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; producerCode?: unknown };
  return e.code === 'rate_limited' || e.producerCode === 'rate_limited';
}

/** Retry-after seconds -> ms, falling back to one limiter window. */
function rateLimitWaitMs(retryAfterSeconds: number | null): number {
  const seconds =
    retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS;
  return Math.ceil(seconds) * 1000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform spread in [0, DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS] ms. */
function defaultJitterMs(): number {
  return Math.floor(Math.random() * (DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS + 1));
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface PublishDeps {
  fetchImpl?: FetchImpl;
  /** Unix seconds (injectable for tests). */
  nowSeconds?: () => number;
  /** 128-bit nonce hex (injectable for tests). */
  nonceHex?: () => string;
  /**
   * Total ms one publish may spend sleeping on `429 retry-after` (default
   * DEFAULT_RATE_LIMIT_WAIT_BUDGET_MS). 0 disables waiting entirely: a 429
   * throws immediately, which is what the fallback reconciler wants — it
   * deliberately stops its sweep at the first 429 and lets the next sweep,
   * which already rides WORKER_RECLAIM_INTERVAL_MS, do the waiting.
   */
  rateLimitWaitBudgetMs?: number;
  /** Sleep impl (injectable for tests; default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Spread (ms) added to each `429 retry-after` wait (SLA-354). Default is
   * uniform over [0, DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS]; tests pin it to
   * a constant so the exact-wait assertions stay deterministic.
   */
  jitterMs?: () => number;
}

const te = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexRaw(rawBody: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', rawBody);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSignRaw(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    te.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(canonical));
  return bytesToBase64Url(new Uint8Array(sig));
}

/** Exact canonical string (mirrors auth.ts — pinned by roundtrip test). */
export async function producerSignature(
  secret: string,
  method: string,
  canonicalPath: string,
  timestamp: string,
  nonce: string,
  rawBody: Uint8Array,
): Promise<string> {
  const canonical =
    `${method.toUpperCase()}\n\n` +
    `${canonicalPath}\n\n` +
    `${timestamp}\n\n` +
    `${nonce}\n\n` +
    (await sha256HexRaw(rawBody));
  return hmacSignRaw(secret, canonical);
}

export function defaultNonceHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function defaultFetchImpl(): FetchImpl {
  const impl = (globalThis as { fetch?: unknown }).fetch as
    | ((url: string, init: unknown) => Promise<Response>)
    | undefined;
  if (!impl) throw new ProducerHttpError('network_error', 'no fetch implementation available', { retryable: false });
  return async (url, init) => {
    const res = await impl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return { status: res.status, headers: { get: (n) => res.headers.get(n) }, text: () => res.text() };
  };
}

function errorFromStatus(
  status: number,
  bodyText: string,
  headers: { get(name: string): string | null },
): ProducerHttpError {
  let code: ProducerErrorCode = 'internal_error';
  let message = `queue-api rejected publish (${status})`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
    if (parsed?.error?.code) code = parsed.error.code as ProducerErrorCode;
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
    // Non-JSON body (proxy/edge) — keep the status-based mapping below.
  }
  if (status === 401) return new ProducerHttpError('unauthenticated', message, { status, retryable: false });
  if (status === 409 && code === 'replay_detected') {
    return new ProducerHttpError('replay_detected', message, { status, retryable: true });
  }
  if (status === 409) return new ProducerHttpError('internal_error', message, { status, retryable: false });
  if (status === 422) return new ProducerHttpError('invalid_job', message, { status, retryable: false });
  if (status === 429) {
    const retryAfter = Number(headers.get('retry-after') ?? '');
    return new ProducerHttpError('rate_limited', message, {
      status,
      retryable: true,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    });
  }
  if (status === 503) return new ProducerHttpError('queue_unavailable', message, { status, retryable: true });
  return new ProducerHttpError(code, message, { status, retryable: status >= 500 });
}

/**
 * POST one job to queue-api.
 *
 * Two retry loops, both bounded:
 * - replay_detected: ONE fresh-nonce retry (per plan §Authentication the
 *   dedupe key — not the nonce — is the idempotency identity, so the retry
 *   replays to the same job).
 * - rate_limited: wait the `retry-after` the server named, then retry with a
 *   fresh nonce, for as long as rateLimitWaitBudgetMs lasts (SLA-349). The
 *   wait is local to this one publish, so a fan-out loop keeps its serial
 *   shape and claims are never stalled behind a shared timer.
 */
export async function publishJobHttp(
  cfg: ProducerConfig,
  body: PublishBody,
  deps: PublishDeps = {},
): Promise<PublishAccepted> {
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const nonceHex = deps.nonceHex ?? defaultNonceHex;
  const sleep = deps.sleep ?? defaultSleep;
  const jitterMs = deps.jitterMs ?? defaultJitterMs;
  // Per-call override (the reconciler passes 0) beats the deployment default
  // (env) beats the built-in one-limiter-window default.
  const waitBudgetMs =
    deps.rateLimitWaitBudgetMs ?? cfg.rateLimitWaitBudgetMs ?? DEFAULT_RATE_LIMIT_WAIT_BUDGET_MS;
  const rawBody = te.encode(JSON.stringify(body));
  let replayRetries = 0;
  let waitedMs = 0;

  for (;;) {
    const timestamp = String(nowSeconds());
    const nonce = nonceHex();
    const signature = await producerSignature(cfg.secret, 'POST', '/v1/jobs', timestamp, nonce, rawBody);
    let res: { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
    try {
      res = await fetchImpl(`${cfg.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slq-key-id': cfg.keyId,
          'x-slq-timestamp': timestamp,
          'x-slq-nonce': nonce,
          'x-slq-signature': signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new ProducerHttpError(
        'network_error',
        `queue-api unreachable: ${(err as Error).message}`,
        { retryable: true },
      );
    }
    if (res.status === 202) {
      const parsed = JSON.parse(await res.text()) as { jobId?: string; deduped?: boolean };
      if (!parsed.jobId) {
        throw new ProducerHttpError('internal_error', 'queue-api 202 without jobId', {
          status: 202,
          retryable: false,
        });
      }
      return { pgJobId: parsed.jobId, deduped: parsed.deduped === true };
    }
    const err = errorFromStatus(res.status, await res.text(), res.headers);
    // Fresh-nonce retry on replay only; everything else surfaces immediately.
    if (err.code === 'replay_detected' && replayRetries === 0) {
      replayRetries++;
      continue;
    }
    // Honour the wait the server named, but only while the budget lasts. A
    // wait that does not fit is not truncated into a guaranteed second 429 —
    // it surfaces as rate_limited, and the caller keeps today's behaviour
    // (park the row; the reconciler drains it). The jitter (SLA-354)
    // de-aligns publishers that were all refused at the same moment so they
    // do not re-burst into the next window's budget at the same instant; the
    // budget check covers jitter + retry-after together.
    if (err.code === 'rate_limited' && waitBudgetMs > 0) {
      const waitMs = rateLimitWaitMs(err.retryAfterSeconds) + jitterMs();
      if (waitedMs + waitMs <= waitBudgetMs) {
        waitedMs += waitMs;
        await sleep(waitMs);
        continue;
      }
    }
    throw err;
  }
}
