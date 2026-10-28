// ---------------------------------------------------------------------------
// Chrome-TLS HTTP over the residential proxy (yt-dlp's `impersonate=True`).
//
// Unsigned undici/Bun fetch has a Node JA3. TikTok answers /api/creator/item_list
// with 429 or an empty 200. Impit speaks Chrome's TLS + HTTP/2. Cookies from
// the first HTML hit (ttwid, msToken) go back out on the next API call. A WAF
// interstitial is solved in-process and retried once.
//
// Loaded dynamically so Vercel/tests that never scrape via proxy do not need
// the native binary.
// ---------------------------------------------------------------------------

import { currentJobSignal, jobBudgetRemainingMs } from '../job-abort.js';
import { meterBytes } from './bandwidth.js';
import { proxyConfig } from './proxy-http.js';
import { signTikTokUrl } from './sign.js';
import { isWafChallenge, solveWafCookies, type WafCookie } from './waf.js';
import { pageBlobComplete, type TikTokHttp, type TikTokHttpBufferResult, type TikTokHttpResult } from './tiktok-web.js';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTML_MAX = 512 * 1024;
/** Cap on the `text` we keep around for WAF detection / logs. JSON.parse
 *  always runs on the FULL body — truncating first (the old 512KB cap) turned
 *  a valid 20-video /api/challenge/item_list (~560KB+) into "unparseable",
 *  so hashtag refreshes fell back to the evergreen embed playlist and the
 *  3-month recency filter then saved zero videos. */
const JSON_TEXT_CAP = 512 * 1024;

class CookieJar {
  private readonly map = new Map<string, string>();

  apply(cookies: WafCookie[]): void {
    for (const c of cookies) this.map.set(c.name, c.value);
  }

  absorb(headers: Headers): void {
    const getSet = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const raw = typeof getSet === 'function' ? getSet.call(headers) : [];
    const list = raw.length ? raw : [headers.get('set-cookie')].filter((x): x is string => !!x);
    for (const line of list) {
      const pair = line.split(';')[0];
      if (!pair) continue;
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.map.size === 0) return undefined;
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface ImpitLike {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function isConnectFail(err: unknown): boolean {
  return /CONNECT tunnel/i.test(String((err as Error)?.message ?? err));
}

/** Parse JSON from the full body. Truncating first is what broke hashtag latest. */
export function jsonFromBody(raw: string): any | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Per-request cap. Matches proxy-http's DEFAULT_TIMEOUT_MS. A hung CONNECT
 *  with no timeout is what pinned the scraper on @jufmlg and blocked the
 *  rest of the refresh queue. */
export const IMPIT_FETCH_TIMEOUT_MS = 20_000;

/** Retries after the first attempt. TikTok's CDN edge resets connections in bursts. */
export const IMPIT_FETCH_RETRIES = 3;

/** rustls surfaces a peer that drops the socket without close_notify as
 *  UnexpectedEof; that is an edge reset, not a terminal answer. */
export function isRetryableFetch(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return isConnectFail(err)
    || /timed out/i.test(msg)
    || /aborted/i.test(msg)
    || /UnexpectedEof|close_notify|connection (reset|closed)|ECONNRESET/i.test(msg);
}

function retryDelayMs(retry: number): number {
  return 400 * retry + Math.floor(Math.random() * 400);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, jobSignal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onJobAbort = () => reject(new Error(`${label} cancelled: job budget exhausted`));
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    jobSignal?.addEventListener('abort', onJobAbort, { once: true });
    const done = () => { clearTimeout(timer); jobSignal?.removeEventListener('abort', onJobAbort); };
    promise.then(
      (v) => { done(); resolve(v); },
      (e) => { done(); reject(e); },
    );
  });
}

/** Same Impit client; retry only a flaky CONNECT/timeout, never a different provider. */
export async function fetchThrough(
  client: ImpitLike,
  url: string,
  headers: Record<string, string>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<Response> {
  const jobSignal = currentJobSignal();
  let last: unknown;
  for (let attempt = 0; attempt <= IMPIT_FETCH_RETRIES; attempt++) {
    if (jobSignal?.aborted) throw new Error('[proxy:impit] fetch cancelled: job budget exhausted');
    try {
      const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(IMPIT_FETCH_TIMEOUT_MS)
        : undefined;
      const signal = jobSignal && timeoutSignal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, jobSignal])
        : (timeoutSignal ?? jobSignal);
      return await withTimeout(
        client.fetch(url, { headers, redirect: 'follow', ...(signal ? { signal } : {}) }),
        IMPIT_FETCH_TIMEOUT_MS,
        '[proxy:impit] fetch',
        jobSignal,
      );
    } catch (err) {
      last = err;
      if (jobSignal?.aborted || !isRetryableFetch(err) || attempt === IMPIT_FETCH_RETRIES) throw err;
      // A retry that cannot finish inside the job budget only buys a second
      // timeout; fail now so the caller sees the real error, not the race.
      const delay = retryDelayMs(attempt + 1);
      if (jobBudgetRemainingMs() < delay + IMPIT_FETCH_TIMEOUT_MS) throw err;
      // Early resets/timeouts are routine on a residential proxy; only the last retry is worth a warn.
      const line = `[proxy:impit] fetch failed, retry ${attempt + 1}/${IMPIT_FETCH_RETRIES}: ${(err as Error).message}`;
      if (attempt + 1 >= IMPIT_FETCH_RETRIES) console.warn(line);
      else console.info(line);
      await sleep(delay);
    }
  }
  throw last;
}

// One Impit client + cookie jar per proxy URL, process-wide. A fresh client
// per scrape used to re-pay a proxy CONNECT, a TLS handshake AND a ~1-2MB
// homepage fetch every time. Reusing the session keeps the tunnel warm.
let sharedSession: { cfgUrl: string; client: ImpitLike; jar: CookieJar } | null = null;

/** Test seam — drops the pooled client so a new proxy URL takes effect. */
export function resetImpersonatedClient(): void {
  sharedSession = null;
}

/**
 * Read the body, stopping (and cancelling the stream) as soon as `stopWhen`
 * holds. Without it `res.text()` drains the whole page — a TikTok video page
 * is 150-300KB of which the rehydration blob is the only part we parse.
 * Returns the decoded bytes actually pulled, which is what gets metered.
 */
export async function readBody(
  res: Response,
  stopWhen?: (text: string) => boolean,
): Promise<{ raw: string; bytes: number; stopped: boolean }> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!stopWhen || !body || typeof body.getReader !== 'function') {
    const raw = await res.text();
    return { raw, bytes: raw.length, stopped: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let raw = '';
  let bytes = 0;
  let stopped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      raw += decoder.decode(value, { stream: true });
      if (stopWhen(raw)) { stopped = true; break; }
    }
    raw += decoder.decode();
  } finally {
    if (stopped) { try { await reader.cancel(); } catch { /* already gone */ } }
  }
  return { raw, bytes, stopped };
}

function makeHttp(client: ImpitLike, jar: CookieJar): TikTokHttp {
  async function once(
    url: string,
    headers: Record<string, string> | undefined,
    maxBytes: number,
    stopWhen?: (text: string) => boolean,
  ): Promise<TikTokHttpResult> {
    const hdrs: Record<string, string> = {
      'User-Agent': CHROME_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(headers ?? {}),
    };
    const cookie = jar.header();
    if (cookie) hdrs.Cookie = cookie;

    const signed = signTikTokUrl(url, hdrs['User-Agent'] ?? CHROME_UA);
    const res = await fetchThrough(client, signed, hdrs);
    jar.absorb(res.headers);
    const { raw, bytes } = await readBody(res, res.ok ? stopWhen : undefined);
    meterBytes(bytes);
    const json = res.ok && !stopWhen ? jsonFromBody(raw) : null;
    const text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
    return { json, status: res.status, ok: res.ok, text, bytes };
  }

  async function withWaf(
    url: string,
    headers: Record<string, string> | undefined,
    maxBytes: number,
    stopWhen?: (text: string) => boolean,
  ): Promise<TikTokHttpResult> {
    const first = await once(url, headers, maxBytes, stopWhen);
    if (!first.text || !isWafChallenge(first.text)) return first;
    const cookies = solveWafCookies(first.text);
    if (!cookies.length) {
      console.warn('[proxy:impit] WAF page but puzzle unsolved');
      return first;
    }
    jar.apply(cookies);
    console.log(`[proxy:impit] solved WAF (${cookies.map(c => c.name).join(',')}), retrying`);
    return once(url, headers, maxBytes, stopWhen);
  }

  async function getBuffer(
    url: string,
    headers: Record<string, string> | undefined,
    maxBytes: number,
  ): Promise<TikTokHttpBufferResult> {
    const hdrs: Record<string, string> = {
      'User-Agent': CHROME_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'video/mp4,video/*,*/*',
      ...(headers ?? {}),
    };
    const cookie = jar.header();
    if (cookie) hdrs.Cookie = cookie;
    // CDN URLs are not /api/ — signTikTokUrl is a no-op, but skip it anyway
    // so we never mutate a signed playAddr query string.
    const res = await fetchThrough(client, url, hdrs);
    jar.absorb(res.headers);
    const raw = Buffer.from(await res.arrayBuffer());
    const truncated = raw.length > maxBytes;
    const buffer = truncated ? raw.subarray(0, maxBytes) : raw;
    meterBytes(buffer.length);
    return { status: res.status, ok: res.ok, buffer, bytes: buffer.length };
  }

  return {
    async getJson(url, headers) {
      return withWaf(url, { Accept: 'application/json, text/plain, */*', ...(headers ?? {}) }, JSON_TEXT_CAP);
    },
    async getText(url, headers) {
      const r = await withWaf(url, { Accept: 'text/html,application/xhtml+xml', ...(headers ?? {}) }, HTML_MAX, pageBlobComplete);
      return { ...r, json: null };
    },
    async getBuffer(url, headers, maxBytes) {
      return getBuffer(url, headers, maxBytes ?? 12 * 1024 * 1024);
    },
  };
}

export async function createImpersonatedHttp(): Promise<TikTokHttp | null> {
  const cfg = proxyConfig();
  if (!cfg) return null;

  if (sharedSession && sharedSession.cfgUrl === cfg.url) {
    return makeHttp(sharedSession.client, sharedSession.jar);
  }

  let Impit: new (opts: Record<string, unknown>) => ImpitLike;
  try {
    ({ Impit } = await import('impit') as unknown as { Impit: new (opts: Record<string, unknown>) => ImpitLike });
  } catch (err) {
    console.warn(`[proxy:impit] not available: ${(err as Error).message}`);
    return null;
  }

  // Do not add Proxy-Cheap `_session-`: that suffix 500s CONNECT (2026-08-14).
  const client = new Impit({
    browser: 'chrome',
    proxyUrl: cfg.url,
    ignoreTlsErrors: true,
  });
  const jar = new CookieJar();
  console.log('[proxy:impit] chrome TLS via residential proxy');
  try {
    // Bounded like every other fetch here: a stalled warmup would hang
    // scrape creation with no error (the catch below only sees failures).
    const warm = await client.fetch('https://www.tiktok.com/', {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(IMPIT_FETCH_TIMEOUT_MS),
    });
    jar.absorb(warm.headers);
    // Cookies live in headers; the body is ~1-2MB we never read. Cancel it.
    await warm.body?.cancel().catch(() => {});
  } catch {
    // first API call can still sign; cookies just help
  }
  sharedSession = { cfgUrl: cfg.url, client, jar };
  return makeHttp(client, jar);
}
