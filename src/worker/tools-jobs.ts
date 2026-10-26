// ---------------------------------------------------------------------------
// Public-tools lookup jobs (slashloop.dev/tools) — VPS side.
//
// The MCP Worker (src/cf/tools-lookup.ts) never touches tiktok.com: it publishes a signed job to
// queue-api, a VPS worker (WORKER_KINDS names the tools-* kinds) scrapes
// through the proxy against the dedicated TOOLS_WORKSPACE_ID budget, and the
// result is POSTed back to /api/tools/internal/result with the same HMAC envelope queue-api
// uses (src/queue/auth.ts), keyed by TOOLS_CALLBACK_SECRET.
//
// No credits, no video, no source: these jobs never reach lib/credits.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { canonicalString, hmacSign, SLQ_HEADERS } from '../queue/auth.js';
import { extractRehydrationJson, type CreatorIdentity, type TikTokHttp } from '../lib/scrapers/tiktok-web.js';
import { isWafChallenge } from '../lib/scrapers/waf.js';
import type { MediaJobRow } from '../lib/jobs.js';

export type ToolsErrorCode = 'budget' | 'not_found' | 'blocked' | 'error';

/** Pre-authorised bytes for one profile-lite lookup (measured ~1.3 MB). */
export const PROFILE_LITE_ESTIMATE_BYTES = 1.5 * 1024 * 1024;
export const PROFILE_LITE_POST_LIMIT = 12;

const HANDLE_RE = /^[a-z0-9._]{2,24}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ToolsPost {
  id: string;
  createdAt: string | null;
  likes: number;
  comments: number;
  shares: number;
  views: number;
}

export interface ProfileLiteResult {
  handle: string;
  followers: number | null;
  sampled: number;
  avgLikes: number;
  avgComments: number;
  avgShares: number;
  avgViews: number;
  /** Mean (likes + comments + shares) per sampled post. */
  avgEngagement: number;
  /** avgEngagement / followers, percent. Null without a follower count. */
  erByFollowers: number | null;
  /** Total engagement / total views, percent. Null when the sample has no views. */
  erByViews: number | null;
  /** Newest first, up to PROFILE_LITE_POST_LIMIT. */
  posts: ToolsPost[];
  /** posts.slice(0, 3). */
  recent: ToolsPost[];
  takenAt: string;
}

export type ToolsOutcome =
  | { status: 'done'; result: ProfileLiteResult }
  | { status: 'failed'; code: ToolsErrorCode };

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function postFromItem(item: any): ToolsPost | null {
  const id = item?.id ?? item?.video?.id;
  if (id == null || String(id) === '') return null;
  const s = item?.stats ?? {};
  const created = Number(item?.createTime);
  return {
    id: String(id),
    createdAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
    likes: num(s.diggCount ?? item?.diggCount),
    comments: num(s.commentCount ?? item?.commentCount),
    shares: num(s.shareCount ?? item?.shareCount),
    views: num(s.playCount ?? item?.playCount),
  };
}

/** Raw TikTok items + follower count -> the numbers the calculator shows. */
export function shapeProfileLite(
  handle: string,
  followers: number | null,
  items: any[],
  now: Date,
): ProfileLiteResult {
  const posts = items
    .map(postFromItem)
    .filter((p): p is ToolsPost => p !== null)
    // Pinned posts lead the SSR list regardless of age; the sample is "latest N".
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, PROFILE_LITE_POST_LIMIT);
  const n = posts.length;
  const sum = (pick: (p: ToolsPost) => number) => posts.reduce((t, p) => t + pick(p), 0);
  const likes = sum((p) => p.likes);
  const comments = sum((p) => p.comments);
  const shares = sum((p) => p.shares);
  const views = sum((p) => p.views);
  const engagement = likes + comments + shares;
  const avgEngagement = n ? engagement / n : 0;
  return {
    handle,
    followers,
    sampled: n,
    avgLikes: n ? round(likes / n, 1) : 0,
    avgComments: n ? round(comments / n, 1) : 0,
    avgShares: n ? round(shares / n, 1) : 0,
    avgViews: n ? round(views / n, 1) : 0,
    avgEngagement: round(avgEngagement, 1),
    erByFollowers: followers && followers > 0 && n ? round((avgEngagement / followers) * 100, 2) : null,
    erByViews: views > 0 ? round((engagement / views) * 100, 2) : null,
    posts,
    recent: posts.slice(0, 3),
    takenAt: now.toISOString(),
  };
}

// --- error mapping ----------------------------------------------------------

export interface ProfileProbe {
  status: number;
  text: string;
}

/**
 * resolveCreator() answers null for both "no such account" and "TikTok did not
 * give us the page". The profile response tells them apart: 404 or a
 * rehydration state with no secUid means the account is gone/private; 429, a
 * WAF interstitial, an empty 200, or a 200 without any app state is a block.
 */
export function classifyProfileMiss(probe: ProfileProbe | null): ToolsErrorCode {
  if (!probe) return 'error';
  const { status, text } = probe;
  if (status === 404) return 'not_found';
  if (status === 429 || status === 403 || status >= 500 || status <= 0) return 'blocked';
  if (!text || !text.trim() || isWafChallenge(text)) return 'blocked';
  const detail = extractRehydrationJson(text)?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  return detail ? 'not_found' : 'blocked';
}

export function classifyToolsError(err: unknown): ToolsErrorCode {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'TrafficCapExceededError') return 'budget';
  const msg = String(e?.message ?? err ?? '');
  if (/\b(429|403)\b|waf|captcha|challenge|rate.?limit|blocked/i.test(msg)) return 'blocked';
  return 'error';
}

// --- the lookup ---------------------------------------------------------------

export interface ProfileLiteDeps {
  assertBudget(estimatedBytes: number): Promise<void>;
  resolveCreator(handle: string): Promise<CreatorIdentity | null>;
  fetchPosts(identity: CreatorIdentity, limit: number): Promise<any[]>;
  probe(): ProfileProbe | null;
  now(): Date;
}

export async function runProfileLite(handle: string, deps: ProfileLiteDeps): Promise<ToolsOutcome> {
  try {
    await deps.assertBudget(PROFILE_LITE_ESTIMATE_BYTES);
  } catch (err) {
    return { status: 'failed', code: classifyToolsError(err) };
  }
  try {
    const identity = await deps.resolveCreator(handle);
    if (!identity) return { status: 'failed', code: classifyProfileMiss(deps.probe()) };
    const items = await deps.fetchPosts(identity, PROFILE_LITE_POST_LIMIT);
    // A resolvable account with no readable posts is private or empty: nothing to compute.
    if (items.length === 0) return { status: 'failed', code: 'not_found' };
    return { status: 'done', result: shapeProfileLite(handle, identity.followers, items, deps.now()) };
  } catch (err) {
    return { status: 'failed', code: classifyToolsError(err) };
  }
}

/** Records the first profile-page response so a null resolveCreator() can be classified. */
export function probingHttp(inner: TikTokHttp, onProfile: (p: ProfileProbe) => void): TikTokHttp {
  let captured = false;
  const getText = inner.getText?.bind(inner);
  return {
    getJson: inner.getJson.bind(inner),
    getBuffer: inner.getBuffer?.bind(inner),
    getText: getText
      ? async (url, headers) => {
          const res = await getText(url, headers);
          if (!captured && /\/@[^/?]+\/?(\?|$)/.test(url)) {
            captured = true;
            onProfile({ status: res.status, text: res.text });
          }
          return res;
        }
      : undefined,
  };
}

// --- callback -----------------------------------------------------------------

export function callbackHostAllowed(rawUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const allowed = (env.TOOLS_CALLBACK_ALLOWED_HOSTS ?? 'mcp.slashloop.dev')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(u.hostname.toLowerCase());
}

export function signedCallbackHeaders(
  secret: string,
  callbackUrl: string,
  rawBody: string,
  timestamp: string,
  nonce: string,
): Record<string, string> {
  const path = new URL(callbackUrl).pathname;
  const signature = hmacSign(secret, canonicalString('POST', path, timestamp, nonce, rawBody));
  return {
    'content-type': 'application/json',
    [SLQ_HEADERS.timestamp]: timestamp,
    [SLQ_HEADERS.nonce]: nonce,
    [SLQ_HEADERS.signature]: signature,
  };
}

export interface CallbackDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;
  nowSeconds(): number;
  nonce(): string;
  sleep(ms: number): Promise<void>;
}

export const CALLBACK_ATTEMPTS = 3;
const CALLBACK_TIMEOUT_MS = 10_000;

/** POST the signed body; 5xx/network errors retry with a fresh nonce, other 4xx are final. */
export async function postToolsCallback(
  callbackUrl: string,
  secret: string,
  body: unknown,
  deps: CallbackDeps,
): Promise<void> {
  const raw = JSON.stringify(body);
  let last = 'no attempt';
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    const headers = signedCallbackHeaders(secret, callbackUrl, raw, String(deps.nowSeconds()), deps.nonce());
    try {
      const res = await deps.fetch(callbackUrl, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return;
      last = `callback answered ${res.status}`;
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (err) {
      last = `callback failed: ${(err as Error).message}`;
    }
    if (attempt < CALLBACK_ATTEMPTS) await deps.sleep(attempt * 1_000);
  }
  throw new Error(last);
}

// --- job dispatch -------------------------------------------------------------

export interface ToolsJobPayload {
  handle?: unknown;
  callbackUrl?: unknown;
  requestId?: unknown;
}

export interface ToolsJobDeps {
  env: NodeJS.ProcessEnv;
  now(): Date;
  /** Runs fn inside a private byte meter and reports what it moved. */
  measure<T>(fn: () => Promise<T>): Promise<{ value: T; bytes: number }>;
  buildLookup(workspaceId: string, onProfile: (p: ProfileProbe) => void): Omit<ProfileLiteDeps, 'probe'>;
  recordBytes(workspaceId: string, bytes: number, refId: string): Promise<void>;
  callback: CallbackDeps;
  completeJob(id: string, payloadJson: string): Promise<void>;
  failJob(id: string, message: string, opts?: { terminal?: boolean }): Promise<unknown>;
}

export interface ToolsJobResult {
  ok: boolean;
  error?: string;
}

function parsePayload(raw: string): ToolsJobPayload {
  try {
    const p = JSON.parse(raw || '{}');
    return p && typeof p === 'object' ? (p as ToolsJobPayload) : {};
  } catch {
    return {};
  }
}

/** Outcomes the breaker should not count against the kind: the user asked for something unservable. */
function isHealthyOutcome(o: ToolsOutcome): boolean {
  return o.status === 'done' || o.code === 'not_found' || o.code === 'budget';
}

export async function processToolsJob(
  job: Pick<MediaJobRow, 'id' | 'kind' | 'workspaceId' | 'payloadJson'>,
  deps: ToolsJobDeps,
): Promise<ToolsJobResult> {
  const terminal = async (message: string): Promise<ToolsJobResult> => {
    await deps.failJob(job.id, message, { terminal: true });
    return { ok: false, error: message };
  };

  if (job.kind !== 'tools-profile-lite') {
    return terminal(`${job.kind} not implemented yet`);
  }

  const payload = parsePayload(job.payloadJson);
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const callbackUrl = typeof payload.callbackUrl === 'string' ? payload.callbackUrl : '';
  const secret = (deps.env.TOOLS_CALLBACK_SECRET ?? '').trim();
  const toolsWorkspace = (deps.env.TOOLS_WORKSPACE_ID ?? '').trim();

  if (!REQUEST_ID_RE.test(requestId)) return terminal('tools job has no valid requestId');
  if (!callbackHostAllowed(callbackUrl, deps.env)) return terminal('tools job callbackUrl is not allowed');
  if (!secret) return terminal('TOOLS_CALLBACK_SECRET is not configured');
  if (!toolsWorkspace) return terminal('TOOLS_WORKSPACE_ID is not configured');
  // The cap and the byte ledger are keyed on the workspace: a job for any
  // other workspace would spend (or dodge) someone else's budget.
  if (job.workspaceId !== toolsWorkspace) return terminal('tools job is not in the tools workspace');

  const handle = typeof payload.handle === 'string' ? payload.handle.trim().toLowerCase() : '';
  const started = Date.now();
  let probe: ProfileProbe | null = null;

  let outcome: ToolsOutcome;
  let bytes = 0;
  if (!HANDLE_RE.test(handle)) {
    outcome = { status: 'failed', code: 'not_found' };
  } else {
    const lookup = deps.buildLookup(job.workspaceId, (p) => { probe = p; });
    const measured = await deps.measure(() => runProfileLite(handle, { ...lookup, probe: () => probe }));
    outcome = measured.value;
    bytes = measured.bytes;
  }

  if (bytes > 0) {
    await deps.recordBytes(job.workspaceId, bytes, requestId).catch((err: Error) => {
      console.warn(`[tools] failed to record ${bytes}B for ${requestId}: ${err.message}`);
    });
  }

  const body =
    outcome.status === 'done'
      ? { requestId, status: 'done', result: outcome.result }
      : { requestId, status: 'failed', code: outcome.code };
  try {
    await postToolsCallback(callbackUrl, secret, body, deps.callback);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[tools] ${job.kind} job ${job.id.slice(0, 8)} callback undelivered: ${message}`);
    await deps.failJob(job.id, message);
    return { ok: false, error: message };
  }

  console.log(
    `[tools] ${job.kind} job ${job.id.slice(0, 8)} @${handle} -> `
    + `${outcome.status === 'done' ? 'done' : `failed:${outcome.code}`} `
    + `bytes=${bytes} duration=${Date.now() - started}ms`,
  );
  await deps.completeJob(job.id, JSON.stringify(outcome.status === 'done' ? { status: 'done', sampled: outcome.result.sampled } : outcome));
  if (isHealthyOutcome(outcome)) return { ok: true };
  return { ok: false, error: `lookup failed: ${outcome.status === 'failed' ? outcome.code : 'unknown'}` };
}

/** Production wiring: real scraper, ledger, queue lifecycle and fetch. */
export async function defaultToolsJobDeps(): Promise<ToolsJobDeps> {
  const [bandwidth, budget, web, impersonate, jobs] = await Promise.all([
    import('../lib/scrapers/bandwidth.js'),
    import('../lib/scrapers/budget.js'),
    import('../lib/scrapers/tiktok-web.js'),
    import('../lib/scrapers/impersonate-http.js'),
    import('../lib/jobs.js'),
  ]);
  return {
    env: process.env,
    now: () => new Date(),
    measure: (fn) =>
      bandwidth.withMeterScope(async () => {
        const value = await fn();
        return { value, bytes: bandwidth.scopeBytesUsed() };
      }),
    buildLookup: (workspaceId, onProfile) => {
      let httpOnce: Promise<TikTokHttp> | null = null;
      const http = () => (httpOnce ??= impersonate.createImpersonatedHttp().then((h) => h ?? web.unsignedHttp));
      return {
        assertBudget: (estimate) => budget.assertProxyBudget(workspaceId, estimate),
        resolveCreator: async (h) => web.withTikTokHttp(probingHttp(await http(), onProfile), () => web.resolveCreator(h)),
        fetchPosts: async (identity, limit) => {
          const { items } = await web.withTikTokHttp(await http(), () => web.fetchCreatorPosts(identity, { limit }));
          return items;
        },
        now: () => new Date(),
      };
    },
    recordBytes: async (workspaceId, bytes, refId) => {
      await bandwidth.recordTrafficBytes(workspaceId, bytes, refId);
    },
    callback: {
      fetch: (url, init) => fetch(url, init),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      nonce: () => randomBytes(16).toString('hex'),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    completeJob: (id, payloadJson) => jobs.completeJob(id, null, payloadJson),
    failJob: (id, message, opts) => jobs.failJob(id, message, opts),
  };
}
