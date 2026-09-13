// Shared fetch layer for provider calls: bounded retries on transient
// failures, then classification into the error triad via the provider's
// handleErrors. Ported concept from Postiz's SocialAbstract.fetch, minus the
// undici dispatcher (Workers fetch needs no SSRF guard for outbound calls to
// public platform APIs) and minus Temporal heartbeat plumbing.

import { BadBodyError, classifyHttpError, RefreshTokenError, ReconnectError } from './errors.js';

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Media URLs are user-influenced: only plain http(s) to public hosts, and
 *  never the worker's own origin (a self-fetch would loop). */
export function assertPublicHttpUrl(url: string, what = 'media'): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadBodyError(`Invalid ${what} URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadBodyError(`${what} URL must be http(s)`);
  }
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(parsed.hostname)) {
    throw new BadBodyError(`${what} URL must be publicly reachable`);
  }
  return url;
}

export interface ProviderFetchOptions extends RequestInit {
  /** Provider-specific error classification, tried before the status-code fallback. */
  classify?: (body: string, status: number) => 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined;
  /** Number of milliseconds to wait for the platform response. */
  timeoutMs?: number;
  /** Overridden in tests; production sleeps RETRY_BACKOFF_MS. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * fetch() that only ever resolves with a 2xx response. Non-2xx bodies are
 * classified (provider hook → status fallback) and thrown as the matching
 * error-triad type; 'retry' classifications back off and re-attempt up to
 * MAX_RETRIES before surfacing as BadBodyError.
 */
export async function providerFetch(url: string, options: ProviderFetchOptions = {}): Promise<Response> {
  const { classify, timeoutMs = DEFAULT_TIMEOUT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...init } = options;

  let lastStatus = 0;
  let lastBody = '{}';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`provider timeout after ${timeoutMs}ms`)), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: init.signal ?? ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      // Aborted by the caller (request teardown) — not transient, rethrow.
      if (init.signal?.aborted) throw err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new BadBodyError(`Network error talking to the platform: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    if (response.ok) return response;

    lastStatus = response.status;
    lastBody = await response.text().catch(() => '{}');

    const kind = classify?.(lastBody, lastStatus) ?? classifyHttpError(lastStatus, lastBody);
    if (kind === 'retry' && attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (kind === 'refresh-token') throw new RefreshTokenError();
    if (kind === 'reconnect') throw new ReconnectError(extractMessage(lastBody) || 'Please reconnect this account');
    throw new BadBodyError(extractMessage(lastBody) || `Platform request failed (${lastStatus})`);
  }

  throw new BadBodyError(extractMessage(lastBody) || `Platform request failed (${lastStatus})`);
}

/** Pull the most human-readable message out of the JSON error shapes the
 *  three platforms use (Meta {error:{message}}, TikTok {error:{...}},
 *  YouTube/Google {error:{message}} and {error_description}); falls back to a
 *  trimmed body snippet. */
export function extractMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    return (
      parsed?.error?.message ??
      parsed?.error?.description ??
      (typeof parsed?.error === 'string' ? parsed.error : undefined) ??
      parsed?.error_description ??
      parsed?.message ??
      body.slice(0, 200)
    );
  } catch {
    return body.slice(0, 200) || undefined;
  }
}

/**
 * Ranged GET of one media byte range, streamed (never buffered whole).
 * Mirrors Postiz's guard: a store that ignores Range (200 + full file) would
 * silently corrupt a chunked upload at this offset, so anything but 206 is
 * an error.
 */
export async function fetchMediaRange(url: string, start: number, end: number): Promise<Response> {
  assertPublicHttpUrl(url);
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' },
  });
  if (response.status !== 206 || !response.body) {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
    throw new BadBodyError('The media storage did not return the requested byte range');
  }
  return response;
}

/** HEAD for the total byte size (chunk-count math input); 0/negative/NaN
 *  sizes are rejected up front rather than poisoning the chunk plan. */
export async function fetchMediaSize(url: string): Promise<number> {
  assertPublicHttpUrl(url);
  const head = await fetch(url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
  const length = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isFinite(length) || length <= 0) {
    throw new BadBodyError('Could not determine the media size for upload');
  }
  return length;
}
