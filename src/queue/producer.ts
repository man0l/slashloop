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
// ---------------------------------------------------------------------------

export interface ProducerConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
  /** Per-request timeout ms (default 10s — queue-api is local to its VPS). */
  timeoutMs: number;
}

export const DEFAULT_PRODUCER_TIMEOUT_MS = 10_000;

/** Env: QUEUE_API_URL (default https://queue.slashloop.dev), key id/secret. */
export function loadProducerConfig(env: NodeJS.ProcessEnv = process.env): ProducerConfig | null {
  const baseUrl = (env.QUEUE_API_URL ?? 'https://queue.slashloop.dev').trim().replace(/\/+$/, '');
  const keyId = (env.QUEUE_API_KEY_ID ?? '').trim();
  const secret = (env.QUEUE_API_KEY_SECRET ?? '').trim();
  if (!baseUrl || !keyId || !secret) return null;
  const timeoutRaw = Number(env.QUEUE_API_TIMEOUT_MS ?? DEFAULT_PRODUCER_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_PRODUCER_TIMEOUT_MS;
  return { baseUrl, keyId, secret, timeoutMs };
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
 * POST one job to queue-api. Retries ONCE with a fresh nonce when the server
 * reports replay_detected (per plan §Authentication the dedupe key — not the
 * nonce — is the idempotency identity, so the retry replays to the same job).
 */
export async function publishJobHttp(
  cfg: ProducerConfig,
  body: PublishBody,
  deps: PublishDeps = {},
): Promise<PublishAccepted> {
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const nonceHex = deps.nonceHex ?? defaultNonceHex;
  const rawBody = te.encode(JSON.stringify(body));

  for (let attempt = 0; attempt < 2; attempt++) {
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
    if (err.code === 'replay_detected' && attempt === 0) continue;
    throw err;
  }
  throw new ProducerHttpError('replay_detected', 'nonce replayed twice', { status: 409, retryable: true });
}
