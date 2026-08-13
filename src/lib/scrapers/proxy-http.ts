// ---------------------------------------------------------------------------
// Metered HTTP over a rotating residential proxy.
//
// Every byte here is paid for by the gigabyte, so this module exists to make
// the wire as narrow as possible and to KNOW how narrow it was:
//
//  1. Compression is mandatory. `Accept-Encoding: br, gzip` and a browser-ish
//     header set — an uncompressed TikTok JSON page is ~8-10x a brotli'd one.
//  2. Every response is capped (`maxBytes`) and the body is read as a STREAM,
//     so the cap aborts the transfer mid-flight instead of after the fact.
//     Aborting is the only thing that actually stops a payload from being
//     billed; checking Content-Length after `await res.text()` does not.
//  3. `stopWhen` lets a caller quit as soon as it has what it needs. Reading
//     the first ~120KB of a TikTok profile page is enough to lift the
//     rehydration JSON out of it; the remaining ~1.4MB of markup, inlined CSS
//     and lazy-loaded module preloads is pure waste.
//  4. Connections are pooled through ONE dispatcher, so a scrape pays for a
//     single TLS handshake and a single proxy CONNECT instead of one per page.
//  5. Bytes are metered from Content-Length when the server sends it (that is
//     the COMPRESSED, on-the-wire figure) and from the decoded length
//     otherwise — the conservative direction, since decoded >= compressed.
//
// Media (MP4s, cover images) must NEVER travel through here: one video is
// bigger than a thousand metadata calls. It goes direct, off-proxy.
// ---------------------------------------------------------------------------

import { meterBytes } from './bandwidth.js';

export interface ProxyConfig {
  url: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Parse SCRAPER_PROXY_URL. Accepts a full URL or the bare
 * `user:pass@host:port` form the proxy vendors hand out.
 */
export function parseProxyUrl(raw: string | undefined): ProxyConfig | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : 8080;
  if (!Number.isFinite(port) || port <= 0) return null;
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  let password = u.password ? decodeURIComponent(u.password) : undefined;
  // Proxy-Cheap encodes geo in the password. A random IN/CN/HK exit serves
  // TikTok's discontinued /in/about page. Default US; set SCRAPER_PROXY_COUNTRY
  // empty to leave the password untouched.
  const country = (process.env.SCRAPER_PROXY_COUNTRY ?? 'US').trim();
  if (password && country && !/_country-/i.test(password)) {
    password = `${password}_country-${country}`;
  }
  // Rebuild rather than echo the input: normalises the bare form and drops any
  // path/query a copy-paste dragged along.
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@` : '';
  return {
    url: `${u.protocol}//${auth}${u.hostname}:${port}`,
    host: u.hostname,
    port,
    username,
    password,
  };
}

export function proxyConfig(): ProxyConfig | null {
  return parseProxyUrl(process.env.SCRAPER_PROXY_URL);
}

/**
 * Proxy-Cheap sticky session. Dashboard format is
 * `password_country-UnitedStates_session-AbCdEf12` so each browser
 * launch pins one residential IP instead of rotating mid-handshake
 * (which TikTok treats as a bot).
 */
export function withStickySession(cfg: ProxyConfig, country = 'UnitedStates'): ProxyConfig {
  const pass = cfg.password ?? '';
  if (pass.includes('_session-')) return cfg;
  const session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // parseProxyUrl already pins _country-US. Only add a session id here.
  const password = `${pass}_session-${session}`;
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(password)}@`
    : '';
  const u = new URL(cfg.url);
  return {
    ...cfg,
    password,
    url: `${u.protocol}//${auth}${cfg.host}:${cfg.port}`,
  };
}

// --- Dispatcher -------------------------------------------------------------
// Bun's fetch takes `proxy` directly. Node's takes an undici `dispatcher`.
// Both are resolved once and reused, because connection reuse is itself a
// bandwidth optimisation: a fresh proxy CONNECT + TLS handshake per request
// is several KB of pure overhead repeated for every page of a scrape.

let dispatcherPromise: Promise<unknown> | null = null;

function isBun(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}

async function proxyDispatcher(proxyUrl: string): Promise<unknown> {
  if (!dispatcherPromise) {
    dispatcherPromise = (async () => {
      const { ProxyAgent } = await import('undici');
      return new ProxyAgent({ uri: proxyUrl, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });
    })();
  }
  return dispatcherPromise;
}

/** Test seam — drops the pooled dispatcher so a new proxy URL takes effect. */
export function resetDispatcher(): void {
  dispatcherPromise = null;
}

// --- Request ----------------------------------------------------------------

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 256KB. Comfortably above any JSON page we ask for, far below a full render. */
export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface ProxyFetchOptions {
  /** Hard ceiling on the body; the transfer is ABORTED once crossed. */
  maxBytes?: number;
  /** Quit early once the text read so far satisfies this. */
  stopWhen?: (textSoFar: string) => boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Bypass the proxy (media hosts are cheaper and safer fetched direct). */
  direct?: boolean;
  method?: string;
  body?: string;
  /**
   * Ask the server to compress. Default true for HTML/JSON. Must be false
   * for MP4s: they are already compressed, and a gzip re-encode wastes CPU
   * without saving a billed byte.
   */
  compress?: boolean;
}

export interface ProxyFetchResult {
  status: number;
  ok: boolean;
  text: string;
  /** What this call cost in traffic. Already added to the process meter. */
  bytes: number;
  /** True when maxBytes or stopWhen cut the transfer short. */
  truncated: boolean;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * One metered request. Never throws on a non-2xx — the status is returned so
 * the caller can decide, because a 404 body still cost real bytes and must be
 * metered rather than lost to an exception.
 */
async function openRequest(url: string, opts: ProxyFetchOptions): Promise<{
  res: Response;
  controller: AbortController;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(opts.headers ?? {}),
  };
  // Brotli first: it is materially smaller than gzip on HTML/JSON, and on a
  // per-GB plan "materially smaller" is the whole product.
  if (opts.compress !== false && !headers['Accept-Encoding'] && !headers['accept-encoding']) {
    headers['Accept-Encoding'] = 'br, gzip';
  }

  const init: Record<string, unknown> = {
    method: opts.method ?? 'GET',
    signal: controller.signal,
    headers,
  };
  if (opts.body != null) init.body = opts.body;

  if (!opts.direct) {
    const cfg = proxyConfig();
    if (cfg) {
      if (isBun()) init.proxy = cfg.url;
      else init.dispatcher = await proxyDispatcher(cfg.url);
    }
  }

  try {
    const res = await fetch(url, init as RequestInit);
    return { res, controller };
  } finally {
    clearTimeout(timeout);
  }
}

function billedBytes(res: Response, decodedBytes: number, truncated: boolean): number {
  // Content-Length, when present, is the compressed size actually billed by
  // the proxy. Prefer it; fall back to the decoded byte count, which can only
  // over-state (never under-state) what was consumed.
  const declared = Number(res.headers.get('content-length') ?? NaN);
  return Number.isFinite(declared) && declared > 0 && !truncated ? declared : decodedBytes;
}

export async function proxyFetch(url: string, opts: ProxyFetchOptions = {}): Promise<ProxyFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const { res, controller } = await openRequest(url, opts);
  const { text, decodedBytes, truncated } = await readCapped(res, maxBytes, opts.stopWhen, controller);
  const bytes = billedBytes(res, decodedBytes, truncated);
  meterBytes(bytes);
  return { status: res.status, ok: res.ok, text, bytes, truncated, headers: res.headers };
}

export interface ProxyFetchBufferResult {
  status: number;
  ok: boolean;
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
  headers: Headers;
}

/**
 * Metered binary GET. Same cap/abort rules as proxyFetch, but the body is
 * kept as bytes so an MP4 is not run through a UTF-8 decoder.
 */
export async function proxyFetchBuffer(
  url: string,
  opts: ProxyFetchOptions = {},
): Promise<ProxyFetchBufferResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const { res, controller } = await openRequest(url, { ...opts, compress: opts.compress ?? false });
  const { buffer, decodedBytes, truncated } = await readCappedBytes(res, maxBytes, controller);
  const bytes = billedBytes(res, decodedBytes, truncated);
  meterBytes(bytes);
  return { status: res.status, ok: res.ok, buffer, bytes, truncated, headers: res.headers };
}

async function readCapped(
  res: Response,
  maxBytes: number,
  stopWhen: ((text: string) => boolean) | undefined,
  controller: AbortController,
): Promise<{ text: string; decodedBytes: number; truncated: boolean }> {
  const body = res.body as ReadableStream<Uint8Array> | null;

  // No stream (mocked responses in tests, some runtimes): fall back to the
  // buffered read and cap after the fact. Correct, just not preventative.
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    const decodedBytes = byteLength(text);
    return decodedBytes > maxBytes
      ? { text: text.slice(0, maxBytes), decodedBytes, truncated: true }
      : { text, decodedBytes, truncated: false };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let decodedBytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - decodedBytes;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        decodedBytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
        if (value.byteLength > remaining) { truncated = true; break; }
      }
      if (decodedBytes >= maxBytes) { truncated = true; break; }
      if (stopWhen && stopWhen(text)) { truncated = true; break; }
    }
    text += decoder.decode();
  } finally {
    // Abort BEFORE cancel: cancel alone can let an HTTP/2 stream drain to the
    // client buffer, which is exactly the traffic the cap is meant to prevent.
    if (truncated) {
      try { controller.abort(); } catch { /* already gone */ }
      try { await reader.cancel(); } catch { /* already gone */ }
    }
  }

  return { text, decodedBytes, truncated };
}

function byteLength(s: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length;
}

async function readCappedBytes(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ buffer: Buffer; decodedBytes: number; truncated: boolean }> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const raw = Buffer.from(await res.arrayBuffer());
    return raw.length > maxBytes
      ? { buffer: raw.subarray(0, maxBytes), decodedBytes: raw.length, truncated: true }
      : { buffer: raw, decodedBytes: raw.length, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let decodedBytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - decodedBytes;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          decodedBytes += remaining;
          truncated = true;
          break;
        }
        chunks.push(value);
        decodedBytes += value.byteLength;
      }
      if (decodedBytes >= maxBytes) { truncated = true; break; }
    }
  } finally {
    if (truncated) {
      try { controller.abort(); } catch { /* already gone */ }
      try { await reader.cancel(); } catch { /* already gone */ }
    }
  }

  return { buffer: Buffer.concat(chunks, decodedBytes), decodedBytes, truncated };
}

/** GET + JSON.parse, metered. Returns null when the body is not valid JSON. */
export async function proxyFetchJson<T = any>(
  url: string,
  opts: ProxyFetchOptions = {},
): Promise<{ json: T | null; result: ProxyFetchResult }> {
  const result = await proxyFetch(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers ?? {}) },
  });
  if (!result.ok || !result.text) return { json: null, result };
  try {
    return { json: JSON.parse(result.text) as T, result };
  } catch {
    return { json: null, result };
  }
}
