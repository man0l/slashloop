// Public tools lookup gate (slashloop.dev/tools, SLA-1056).
//
//   POST /api/tools/lookup           visitor -> verified -> queue job
//   GET  /api/tools/lookup/<id>      status / result (never starts a scrape)
//   POST /api/tools/internal/result  signed callback from the VPS job worker
//
// The `transcript` kind (SLA-1057) takes a video link instead of a handle: it is normalised
// (short links resolved via HEAD), validated with TikTok oEmbed and queued as `tools-video`.
// This Worker never scrapes TikTok: it checks Turnstile and limits, publishes a
// `tools-profile-lite` job to queue-api and later receives the VPS result
// (src/worker/tools-jobs.ts signs it with TOOLS_CALLBACK_SECRET). State lives
// in D1 (tools_lookups: status + result, so polling never waits on KV
// propagation); KV holds only the 7-day result cache, the daily counters and
// the callback nonce set.

import { timingSafeEqual } from 'node:crypto';
import { corsHeaders, corsPreflight } from '../lib/cors.js';
import { normalizeHandle } from '../lib/tools-handle.js';
import { fetchOembed, parseVideoLink, resolveShortLink, type VideoPreview, type VideoRef } from '../lib/tools-video-url.js';
import {
  loadProducerConfig,
  producerSignature,
  publishJobHttp,
  type PublishAccepted,
  type PublishBody,
  type ProducerConfig,
} from '../queue/producer.js';
import type { Env } from './env.js';

export const LOOKUP_KIND = 'profile-lite';
export const QUEUE_KIND = 'tools-profile-lite';
export const VIDEO_LOOKUP_KIND = 'transcript';
export const VIDEO_QUEUE_KIND = 'tools-video';
/** Full analyzer behind the creator pages (SLA-1058): same handle target as profile-lite, own cache, limits and job kind. */
export const PROFILE_LOOKUP_KIND = 'profile';
export const PROFILE_QUEUE_KIND = 'tools-profile';
export const RESULT_PATH = '/api/tools/internal/result';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_ORIGIN = 'https://mcp.slashloop.dev';
const DEFAULT_SITE_URL = 'https://slashloop.dev';
export const SITE_CREATOR_PATH = '/tools/api/internal/creator';
export const SITE_REMOVAL_PATH = '/tools/api/internal/removal';
const SITE_PUSH_TIMEOUT_MS = 8_000;

export const RESULT_TTL_SECONDS = 7 * 24 * 3600;
export const VIDEO_RESULT_TTL_SECONDS = 30 * 24 * 3600;
export const NONCE_TTL_SECONDS = 600;
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;
const AUTH_SKEW_SECONDS = 300;
const PENDING_WINDOW_MS = 10 * 60 * 1000;
const JOB_DEADLINE_MS = 10 * 60 * 1000;
const PUBLISH_TIMEOUT_MS = 8_000;
export const DAILY_IP_LIMIT = 20;
export const DAILY_HANDLE_LIMIT = 5;
export const DAILY_VIDEO_IP_LIMIT = 10;
export const DAILY_VIDEO_LIMIT = 3;
/** New lookups per client per rolling minute, counted in D1 (LOOKUP_RL is per-colo and only approximate). */
export const MINUTE_IP_LIMIT = 3;
const MINUTE_WINDOW_MS = 60 * 1000;
export const REFRESH_AFTER_MS = 24 * 3600 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_CALLBACK_BYTES = 256 * 1024;

export const SLIDESHOW_MESSAGE =
  'This is a photo slideshow; there is no audio to transcribe. Try the hook extractor in Slashloop instead.';
const VIDEO_NOT_FOUND = 'Video not found or private.';

const ERROR_MESSAGES: Record<string, string> = {
  budget: 'Daily lookup budget reached. Try again tomorrow.',
  not_found: 'That account does not exist or is private.',
  blocked: 'TikTok is rate limiting us right now. Try again in a few minutes.',
  slideshow: SLIDESHOW_MESSAGE,
  too_long: 'That video is too long to transcribe. Try one under 10 minutes.',
  error: 'The lookup failed. Please try again in a few minutes.',
};
export const errorMessage = (code: string | null | undefined, kind?: string | null): string => {
  if (kind === VIDEO_LOOKUP_KIND && code === 'not_found') return VIDEO_NOT_FOUND;
  return ERROR_MESSAGES[code ?? ''] ?? ERROR_MESSAGES.error;
};

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface ToolsLookupEnv {
  DB_SHARD0: D1Database;
  /** Shared with the OAuth provider; every key here is prefixed `tools:`. */
  OAUTH_KV: KVNamespace;
  LOOKUP_RL?: RateLimitBinding;
  TURNSTILE_SECRET?: string;
  TOOLS_CALLBACK_SECRET?: string;
  TOOLS_WORKSPACE_ID?: string;
  /** Where creator results are pushed (the slashloop-site Worker). */
  TOOLS_SITE_URL?: string;
  /** Board mailbox for removal-request notices (src/cf/tools-creators.ts); same ALERT_EMAIL the scrape alerts use. */
  ALERT_EMAIL?: string;
  PUBLIC_URL?: string;
  QUEUE_API_URL?: string;
  QUEUE_API_KEY_ID?: string;
  QUEUE_API_KEY_SECRET?: string;
}

export interface ToolsLookupDeps {
  now?: () => Date;
  newId?: () => string;
  publish?: (cfg: ProducerConfig, body: PublishBody) => Promise<PublishAccepted>;
  fetchImpl?: typeof fetch;
}

export const toolsEnv = (env: Env | undefined): ToolsLookupEnv => (env ?? {}) as unknown as ToolsLookupEnv;

export function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      ...corsHeaders(request),
    },
  });
}
export const fail = (request: Request, status: number, message: string, extra: Record<string, unknown> = {}): Response =>
  json(request, { error: message, ...extra }, status);

const cacheKey = (handle: string, kind: string = LOOKUP_KIND): string => `tools:cache:${kind}:${handle}`;
export const yyyymmdd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');
export const noContent = (): Response => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export async function readJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function clientHash(env: ToolsLookupEnv, request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  // Keyed so the stored hash cannot be brute-forced back to an IP.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TOOLS_CALLBACK_SECRET || 'tools'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`client:${ip}`)));
  return Array.from(sig.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyTurnstile(env: ToolsLookupEnv, token: string, ip: string | null, fetchImpl: typeof fetch): Promise<boolean> {
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET ?? '');
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

const bump = (env: ToolsLookupEnv, key: string, current: number): Promise<void> =>
  env.OAUTH_KV.put(key, String(current + 1), { expirationTtl: COUNTER_TTL_SECONDS });

interface Target {
  kind: string;
  queueKind: string;
  subject: string;
  cacheTtl: number;
  ipKey: (hash: string, day: string) => string;
  ipLimit: number;
  subjectKey: (day: string) => string;
  subjectLimit: number;
  subjectLimitMessage: string;
  dedupeKey: (day: string) => string;
  payload: Record<string, unknown>;
  preview: VideoPreview | null;
  refreshable: boolean;
}

type LookupBody = { kind?: unknown; handle?: unknown; url?: unknown; turnstileToken?: unknown; refresh?: unknown };

async function resolveTarget(request: Request, body: LookupBody, deps: ToolsLookupDeps): Promise<Target | Response> {
  if (body.kind === LOOKUP_KIND) {
    const handle = normalizeHandle(body.handle);
    if (!handle) return fail(request, 400, 'Enter a TikTok username (letters, numbers, dots and underscores).');
    return {
      kind: LOOKUP_KIND,
      queueKind: QUEUE_KIND,
      subject: handle,
      cacheTtl: RESULT_TTL_SECONDS,
      ipKey: (hash, day) => `tools:rl:day:${hash}:${day}`,
      ipLimit: DAILY_IP_LIMIT,
      subjectKey: (day) => `tools:rl:handle:${handle}:${day}`,
      subjectLimit: DAILY_HANDLE_LIMIT,
      subjectLimitMessage: 'This account was looked up too many times today. Try again tomorrow.',
      dedupeKey: (day) => `${QUEUE_KIND}:${handle}:${day}`,
      payload: { handle },
      preview: null,
      refreshable: true,
    };
  }
  if (body.kind === PROFILE_LOOKUP_KIND) {
    const handle = normalizeHandle(body.handle);
    if (!handle) return fail(request, 400, 'Enter a TikTok username (letters, numbers, dots and underscores).');
    return {
      kind: PROFILE_LOOKUP_KIND,
      queueKind: PROFILE_QUEUE_KIND,
      subject: handle,
      cacheTtl: RESULT_TTL_SECONDS,
      ipKey: (hash, day) => `tools:rl:day:profile:${hash}:${day}`,
      ipLimit: DAILY_IP_LIMIT,
      subjectKey: (day) => `tools:rl:handle:profile:${handle}:${day}`,
      subjectLimit: DAILY_HANDLE_LIMIT,
      subjectLimitMessage: 'This account was looked up too many times today. Try again tomorrow.',
      dedupeKey: (day) => `${PROFILE_QUEUE_KIND}:${handle}:${day}`,
      payload: { handle, reason: 'lookup' },
      preview: null,
      refreshable: true,
    };
  }
  if (body.kind === VIDEO_LOOKUP_KIND) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const parsed = parseVideoLink(body.url);
    if (parsed.kind === 'invalid') return fail(request, 400, 'Paste a TikTok video link (tiktok.com/@user/video/..., vm.tiktok.com/... or tiktok.com/t/...).');
    if (parsed.kind === 'photo') return fail(request, 400, SLIDESHOW_MESSAGE, { code: 'slideshow' });
    let ref: VideoRef;
    if (parsed.kind === 'video') ref = parsed.ref;
    else {
      const resolved = await resolveShortLink(parsed.url, fetchImpl);
      if (!resolved) return fail(request, 400, VIDEO_NOT_FOUND, { code: 'not_found' });
      if ('photo' in resolved) return fail(request, 400, SLIDESHOW_MESSAGE, { code: 'slideshow' });
      ref = resolved;
    }
    const oembed = await fetchOembed(ref.url, fetchImpl);
    if (!oembed.ok && oembed.notFound) return fail(request, 404, VIDEO_NOT_FOUND, { code: 'not_found' });
    const preview = oembed.ok ? oembed.preview : null;
    return {
      kind: VIDEO_LOOKUP_KIND,
      queueKind: VIDEO_QUEUE_KIND,
      subject: ref.videoId,
      cacheTtl: VIDEO_RESULT_TTL_SECONDS,
      ipKey: (hash, day) => `tools:rl:day:video:${hash}:${day}`,
      ipLimit: DAILY_VIDEO_IP_LIMIT,
      subjectKey: (day) => `tools:rl:video:${ref.videoId}:${day}`,
      subjectLimit: DAILY_VIDEO_LIMIT,
      subjectLimitMessage: 'This video was transcribed too many times today. Try again tomorrow.',
      dedupeKey: () => `${VIDEO_QUEUE_KIND}:${ref.videoId}`,
      payload: { videoUrl: ref.url, videoId: ref.videoId, caption: preview?.title ?? '' },
      preview,
      refreshable: false,
    };
  }
  return fail(request, 400, 'Unsupported lookup kind.');
}

export async function handleLookupPost(request: Request, rawEnv: Env | undefined, deps: ToolsLookupDeps = {}): Promise<Response> {
  const env = toolsEnv(rawEnv);
  const now = (deps.now ?? (() => new Date()))();
  const body = (await readJson(request)) as LookupBody | null;
  if (!body || typeof body !== 'object') return fail(request, 400, 'Invalid request.');
  const target = await resolveTarget(request, body, deps);
  if (target instanceof Response) return target;
  const { subject } = target;
  // The preview (title/thumbnail) is never cached: TikTok's thumbnail URLs are signed and expire.
  const withPreview = (payload: Record<string, unknown>): Record<string, unknown> =>
    target.preview ? { ...payload, preview: target.preview } : payload;

  const cached = (await env.OAUTH_KV.get(cacheKey(subject, target.kind), { type: 'json' })) as { takenAt?: unknown } | null;
  // `refresh` skips the 7-day cache only for a snapshot 24h or older; younger snapshots are always served from it.
  const takenAt = typeof cached?.takenAt === 'string' ? Date.parse(cached.takenAt) : NaN;
  const stale = Number.isFinite(takenAt) && now.getTime() - takenAt >= REFRESH_AFTER_MS;
  if (cached && !(target.refreshable && body.refresh === true && stale)) {
    return json(request, withPreview({ status: 'done', result: cached, cached: true }));
  }

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!token || token.length > 2048) return fail(request, 400, 'Verification failed. Reload the page and try again.');
  if (!env.TURNSTILE_SECRET) return fail(request, 503, 'Lookups are not available right now.');
  const ip = request.headers.get('cf-connecting-ip');
  if (!(await verifyTurnstile(env, token, ip, deps.fetchImpl ?? fetch))) {
    return fail(request, 400, 'Verification failed. Reload the page and try again.');
  }

  if (env.LOOKUP_RL) {
    const { success } = await env.LOOKUP_RL.limit({ key: ip ?? 'unknown' });
    if (!success) return fail(request, 429, 'Too many lookups. Wait a minute and try again.', { retryAfter: 60 });
  }

  const day = yyyymmdd(now);
  const hash = await clientHash(env, request);
  const ipKey = target.ipKey(hash, day);
  const subjectKey = target.subjectKey(day);
  const [ipCount, subjectCount] = await Promise.all([
    env.OAUTH_KV.get(ipKey).then((v) => Number(v) || 0),
    env.OAUTH_KV.get(subjectKey).then((v) => Number(v) || 0),
  ]);
  if (ipCount >= target.ipLimit) return fail(request, 429, 'Daily lookup limit reached. Try again tomorrow.');
  if (subjectCount >= target.subjectLimit) return fail(request, 429, target.subjectLimitMessage);

  const since = new Date(now.getTime() - PENDING_WINDOW_MS).toISOString();
  const pending = await env.DB_SHARD0.prepare(
    "SELECT id FROM tools_lookups WHERE kind = ? AND subject = ? AND status = 'queued' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(target.kind, subject, since)
    .first<{ id: string }>();
  if (pending) return json(request, withPreview({ status: 'queued', id: pending.id }));

  const minuteAgo = new Date(now.getTime() - MINUTE_WINDOW_MS).toISOString();
  const recent = await env.DB_SHARD0.prepare('SELECT COUNT(*) AS n FROM tools_lookups WHERE client_hash = ? AND created_at > ?')
    .bind(hash, minuteAgo)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MINUTE_IP_LIMIT) {
    return fail(request, 429, 'Too many lookups. Wait a minute and try again.', { retryAfter: 60 });
  }

  const workspaceId = env.TOOLS_WORKSPACE_ID?.trim();
  const cfg = loadProducerConfig({
    QUEUE_API_URL: env.QUEUE_API_URL,
    QUEUE_API_KEY_ID: env.QUEUE_API_KEY_ID,
    QUEUE_API_KEY_SECRET: env.QUEUE_API_KEY_SECRET,
  });
  if (!workspaceId || !cfg) return fail(request, 503, 'Lookups are not available right now.');
  // A visitor's request must not sit out a 429 retry-after.
  cfg.rateLimitWaitBudgetMs = 0;
  cfg.timeoutMs = PUBLISH_TIMEOUT_MS;

  const id = (deps.newId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
  const stamp = now.toISOString();
  await env.DB_SHARD0.prepare(
    "INSERT INTO tools_lookups (id, kind, subject, status, result_json, error_code, created_at, updated_at, client_hash) VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?, ?)",
  )
    .bind(id, target.kind, subject, stamp, stamp, hash)
    .run();

  const busy = async (code: string): Promise<Response> => {
    await env.DB_SHARD0.prepare("UPDATE tools_lookups SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
      .bind(code, new Date().toISOString(), id)
      .run();
    return fail(request, 503, 'Lookups are busy, try again in a minute.');
  };

  const origin = (env.PUBLIC_URL ?? '').replace(/\/$/, '') || new URL(request.url).origin || DEFAULT_ORIGIN;
  try {
    const publish = deps.publish ?? ((c, b) => publishJobHttp(c, b));
    const accepted = await publish(cfg, {
      kind: target.queueKind,
      workspaceId,
      videoId: null,
      sourceId: null,
      dedupeKey: target.dedupeKey(day),
      deadlineAt: new Date(now.getTime() + JOB_DEADLINE_MS).toISOString(),
      payload: { ...target.payload, requestId: id, callbackUrl: `${origin}${RESULT_PATH}` },
    });
    if (accepted.deduped) {
      // The same subject is already in flight (the key is released when the job ends); follow that request instead.
      const earlier = await env.DB_SHARD0.prepare(
        "SELECT id FROM tools_lookups WHERE kind = ? AND subject = ? AND status = 'queued' AND id != ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(target.kind, subject, id)
        .first<{ id: string }>();
      if (!earlier) return busy('queue');
      await env.DB_SHARD0.prepare('DELETE FROM tools_lookups WHERE id = ?').bind(id).run();
      return json(request, withPreview({ status: 'queued', id: earlier.id }));
    }
  } catch (err) {
    console.warn(`[tools-lookup] publish failed: ${(err as { code?: string }).code ?? (err as Error).name}`);
    return busy('queue');
  }

  await Promise.all([bump(env, ipKey, ipCount), bump(env, subjectKey, subjectCount)]);
  return json(request, withPreview({ status: 'queued', id }));
}

export async function handleLookupGet(request: Request, id: string, rawEnv: Env | undefined): Promise<Response> {
  const env = toolsEnv(rawEnv);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(request, 404, 'Lookup not found.');
  const row = await env.DB_SHARD0.prepare('SELECT id, status, result_json, error_code, kind FROM tools_lookups WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string; result_json: string | null; error_code: string | null; kind: string }>();
  if (!row) return fail(request, 404, 'Lookup not found.');
  if (row.status === 'done' && row.result_json) return json(request, { status: 'done', result: JSON.parse(row.result_json) });
  if (row.status === 'failed') {
    return json(request, { status: 'failed', code: row.error_code ?? 'error', message: errorMessage(row.error_code, row.kind) });
  }
  return json(request, { status: 'queued', id: row.id });
}

type CallbackBody = { requestId?: unknown; status?: unknown; result?: unknown; code?: unknown };

const unauthenticated = (): Response =>
  new Response(JSON.stringify({ error: 'unauthenticated' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** HMAC + timestamp + one-time nonce check shared by every signed internal endpoint. Returns the raw body or a 401. */
export async function verifySigned(request: Request, env: ToolsLookupEnv, now: Date): Promise<Uint8Array | Response> {
  const secret = env.TOOLS_CALLBACK_SECRET?.trim();
  const timestamp = request.headers.get('x-slq-timestamp') ?? '';
  const nonce = request.headers.get('x-slq-nonce') ?? '';
  const signature = request.headers.get('x-slq-signature') ?? '';
  if (!secret || !/^\d+$/.test(timestamp) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !signature) return unauthenticated();
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > AUTH_SKEW_SECONDS) return unauthenticated();

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_CALLBACK_BYTES) return unauthenticated();
  const expected = Buffer.from(await producerSignature(secret, 'POST', new URL(request.url).pathname, timestamp, nonce, raw));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return unauthenticated();

  // Only a correctly signed request may touch the nonce set, so unauthenticated traffic cannot fill it.
  const nonceKey = `tools:nonce:${nonce}`;
  if (await env.OAUTH_KV.get(nonceKey)) return unauthenticated();
  await env.OAUTH_KV.put(nonceKey, '1', { expirationTtl: NONCE_TTL_SECONDS });
  return raw;
}

/** Signed POST to the site Worker; true only on a 2xx. */
export async function pushToSite(
  env: ToolsLookupEnv,
  path: string,
  payload: unknown,
  deps: ToolsLookupDeps = {},
): Promise<boolean> {
  const secret = env.TOOLS_CALLBACK_SECRET?.trim();
  if (!secret) return false;
  const base = (env.TOOLS_SITE_URL ?? '').replace(/\/$/, '') || DEFAULT_SITE_URL;
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const ts = String(Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slq-timestamp': ts,
        'x-slq-nonce': nonce,
        'x-slq-signature': await producerSignature(secret, 'POST', path, ts, nonce, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(SITE_PUSH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleResultCallback(request: Request, rawEnv: Env | undefined, deps: ToolsLookupDeps = {}): Promise<Response> {
  const env = toolsEnv(rawEnv);
  const now = (deps.now ?? (() => new Date()))();
  const raw = await verifySigned(request, env, now);
  if (raw instanceof Response) return raw;

  let body: CallbackBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as CallbackBody;
  } catch {
    return fail(request, 400, 'Invalid body.');
  }
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return fail(request, 400, 'Invalid requestId.');
  const row = await env.DB_SHARD0.prepare('SELECT subject, status, kind FROM tools_lookups WHERE id = ?')
    .bind(requestId)
    .first<{ subject: string; status: string; kind: string }>();
  if (!row) return fail(request, 404, 'Unknown request.');
  // A retried delivery after the row settled is acknowledged, not applied twice.
  if (row.status !== 'queued') return noContent();

  const stamp = now.toISOString();
  if (body.status === 'done' && body.result && typeof body.result === 'object') {
    // The subject is the one we asked about, not whatever the callback names.
    const isVideo = row.kind === VIDEO_LOOKUP_KIND;
    const subjectField = isVideo ? { videoId: row.subject } : { handle: row.subject };
    const result = JSON.stringify({ ...(body.result as object), ...subjectField });
    // The creator page must exist before the visitor is told the lookup is done; a failed push
    // leaves the row queued and answers 5xx so the VPS retries the delivery.
    if (row.kind === PROFILE_LOOKUP_KIND && !(await pushToSite(env, SITE_CREATOR_PATH, { handle: row.subject, result: JSON.parse(result) }, deps))) {
      console.warn(`[tools-lookup] site push failed for ${row.subject}`);
      return fail(request, 502, 'Could not publish the result.');
    }
    await env.DB_SHARD0.prepare("UPDATE tools_lookups SET status = 'done', result_json = ?, error_code = NULL, updated_at = ? WHERE id = ?")
      .bind(result, stamp, requestId)
      .run();
    await env.OAUTH_KV.put(cacheKey(row.subject, row.kind), result, { expirationTtl: isVideo ? VIDEO_RESULT_TTL_SECONDS : RESULT_TTL_SECONDS });
    return noContent();
  }
  const code = typeof body.code === 'string' && body.code in ERROR_MESSAGES ? body.code : 'error';
  await env.DB_SHARD0.prepare("UPDATE tools_lookups SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
    .bind(code, stamp, requestId)
    .run();
  return noContent();
}

const LOOKUP_ID = /^\/api\/tools\/lookup\/([^/]+)$/;

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function POST(request: Request, env?: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/tools/lookup') return handleLookupPost(request, env);
  if (pathname === RESULT_PATH) return handleResultCallback(request, env);
  return fail(request, 404, 'Not found.');
}

export async function GET(request: Request, env?: Env): Promise<Response> {
  const match = LOOKUP_ID.exec(new URL(request.url).pathname);
  if (match) return handleLookupGet(request, match[1], env);
  return fail(request, 404, 'Not found.');
}
