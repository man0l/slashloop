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
import { extractRehydrationJson, type CreatorIdentity, type EmbedCreatorRead, type TikTokHttp } from '../lib/scrapers/tiktok-web.js';
import { isWafChallenge } from '../lib/scrapers/waf.js';
import type { MediaJobRow } from '../lib/jobs.js';
import { uploadCovers, uploadTrendCovers, type AuthoredCoverTarget, type CoverTarget } from './tools-covers.js';
import { MIN_ENGAGEMENT_POSTS, PROFILE_HYDRATE_PAGES, runProfile } from './tools-profile.js';
import { parseTrendsPayload, runTrends, type TrendsDeps } from './tools-trends.js';
import { defaultVideoDeps, parseVideoPayload, runVideoLookup, type VideoDeps, type VideoOutcome } from './tools-video.js';

export type ToolsErrorCode = 'budget' | 'not_found' | 'blocked' | 'source' | 'slideshow' | 'too_long' | 'error';

/** Pre-authorised bytes for one profile-lite lookup (wire bytes, ~0.3 MB measured). */
export const PROFILE_LITE_ESTIMATE_BYTES = 0.4 * 1024 * 1024;
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
  | { status: 'done'; result: { sampled: number } }
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
  /** Full profile only: one embed read (counts + playlist posts), tried before the profile page. */
  fetchEmbed?(handle: string, limit: number): Promise<EmbedCreatorRead | null>;
  /** Full profile only: jittered wait before re-reading a throttled embed page. */
  pause?(ms: number): Promise<void>;
  /** Full profile only: HTTP status of the public oEmbed lookup for the handle; 0 when it could not be read. */
  oembedStatus?(handle: string): Promise<number>;
  /** Full profile only: fills likes, comments, shares and sound the embed rows lack. */
  hydrate?(items: any[]): Promise<any[]>;
  /** Full profile only: re-hosts outlier covers on the site; returns the stored ids. Never throws the job. */
  uploadCovers?(handle: string, targets: CoverTarget[]): Promise<string[]>;
  probe(): ProfileProbe | null;
  now(): Date;
}

export async function runProfileLite(
  handle: string,
  deps: ProfileLiteDeps,
): Promise<{ status: 'done'; result: ProfileLiteResult } | { status: 'failed'; code: ToolsErrorCode }> {
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

/** Where outlier covers are pushed (SLA-1146); override with TOOLS_SITE_URL. */
const DEFAULT_SITE_URL = 'https://slashloop.dev';

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

/** Carries whether another delivery attempt can plausibly succeed (5xx/408/429/network) or the receiver refused for good (other 4xx). */
export class CallbackDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'CallbackDeliveryError';
  }
}

/** POST the signed body; 5xx/network errors retry with a fresh nonce, other 4xx are final. */
export async function postToolsCallback(
  callbackUrl: string,
  secret: string,
  body: unknown,
  deps: CallbackDeps,
): Promise<void> {
  const raw = JSON.stringify(body);
  let last = 'no attempt';
  let retryable = true;
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
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        retryable = false;
        break;
      }
    } catch (err) {
      last = `callback failed: ${(err as Error).message}`;
    }
    if (attempt < CALLBACK_ATTEMPTS) await deps.sleep(attempt * 1_000);
  }
  throw new CallbackDeliveryError(last, retryable);
}

// --- delivery without re-scraping -----------------------------------------------

/** Everything needed to finish a job once its callback lands, captured before delivery is attempted. */
interface PreparedDelivery {
  body: unknown;
  log: string;
  completePayload: string;
  result: ToolsJobResult;
}

/**
 * A scrape that succeeded but could not be delivered. Requeueing the job would otherwise re-run the
 * scrape through the metered proxy, so the finished result waits here (per worker process) and the
 * retry goes straight to the callback. A different worker, or a restart, falls back to a re-scrape.
 */
const PENDING_TTL_MS = 30 * 60_000;
const PENDING_MAX = 200;
const pendingDeliveries = new Map<string, { prepared: PreparedDelivery; expires: number }>();

export function resetPendingDeliveries(): void {
  pendingDeliveries.clear();
}

function stashDelivery(jobId: string, prepared: PreparedDelivery): void {
  const now = Date.now();
  for (const [id, entry] of pendingDeliveries) if (entry.expires <= now) pendingDeliveries.delete(id);
  while (pendingDeliveries.size >= PENDING_MAX) pendingDeliveries.delete(pendingDeliveries.keys().next().value as string);
  pendingDeliveries.set(jobId, { prepared, expires: now + PENDING_TTL_MS });
}

function takeDelivery(jobId: string): PreparedDelivery | null {
  const entry = pendingDeliveries.get(jobId);
  if (!entry) return null;
  pendingDeliveries.delete(jobId);
  return entry.expires > Date.now() ? entry.prepared : null;
}

/** Post the callback, then settle the job. A retryable failure keeps the result for the requeued attempt; a 4xx fails terminally. */
async function deliver(
  job: { id: string; kind?: string },
  prepared: PreparedDelivery,
  callbackUrl: string,
  secret: string,
  deps: ToolsJobDeps,
): Promise<ToolsJobResult> {
  try {
    await postToolsCallback(callbackUrl, secret, prepared.body, deps.callback);
  } catch (err) {
    const message = (err as Error).message;
    const retryable = !(err instanceof CallbackDeliveryError) || err.retryable;
    console.warn(`[tools] ${job.kind ?? 'tools'} job ${job.id.slice(0, 8)} callback undelivered (${retryable ? 'will retry callback only' : 'terminal'}): ${message}`);
    if (retryable) stashDelivery(job.id, prepared);
    await deps.failJob(job.id, message, retryable ? undefined : { terminal: true });
    return { ok: false, error: message };
  }
  console.log(prepared.log);
  await deps.completeJob(job.id, prepared.completePayload);
  return prepared.result;
}

// --- job dispatch -------------------------------------------------------------

export interface ToolsJobPayload {
  handle?: unknown;
  videoUrl?: unknown;
  videoId?: unknown;
  caption?: unknown;
  callbackUrl?: unknown;
  requestId?: unknown;
  /** 'lookup' (a visitor asked) or 'refresh' (weekly cron); logged only. */
  reason?: unknown;
}

export interface ToolsJobDeps {
  env: NodeJS.ProcessEnv;
  now(): Date;
  /** Runs fn inside a private byte meter and reports what it moved. */
  measure<T>(fn: () => Promise<T>): Promise<{ value: T; bytes: number }>;
  /** `fresh` re-reads the profile even when its secUid is cached, so the follower count is always present. */
  buildLookup(workspaceId: string, onProfile: (p: ProfileProbe) => void, opts?: { fresh?: boolean }): Omit<ProfileLiteDeps, 'probe'>;
  buildTrends?(workspaceId: string): TrendsDeps;
  buildVideo(workspaceId: string): VideoDeps;
  recordBytes(workspaceId: string, bytes: number, refId: string): Promise<void>;
  callback: CallbackDeps;
  /** Direct (off-proxy) fetch for outlier covers and their push to the site; unset disables covers. */
  coverFetch?: (input: string, init?: RequestInit) => Promise<Response>;
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
function isHealthyOutcome(o: ToolsOutcome | VideoOutcome): boolean {
  return o.status === 'done' || ['not_found', 'budget', 'slideshow', 'too_long'].includes(o.code);
}

/** Mirrors MAX_ATTEMPTS in lib/jobs.ts (a value import would pull the DB client into this module). */
const QUEUE_MAX_ATTEMPTS = 3;

/** Throttled or network-failed reads: says nothing about the account, so worth another try with queue backoff. */
function isTransientOutcome(o: ToolsOutcome | VideoOutcome): boolean {
  return o.status === 'failed' && (o.code === 'blocked' || o.code === 'error');
}

export async function processToolsJob(
  job: Pick<MediaJobRow, 'id' | 'kind' | 'workspaceId' | 'payloadJson'> & { attempts?: number },
  deps: ToolsJobDeps,
): Promise<ToolsJobResult> {
  const terminal = async (message: string): Promise<ToolsJobResult> => {
    await deps.failJob(job.id, message, { terminal: true });
    return { ok: false, error: message };
  };

  if (job.kind !== 'tools-profile-lite' && job.kind !== 'tools-profile' && job.kind !== 'tools-trends' && job.kind !== 'tools-video') {
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

  const pending = takeDelivery(job.id);
  if (pending) {
    console.log(`[tools] ${job.kind} job ${job.id.slice(0, 8)} retrying callback only (scrape result kept, attempt=${job.attempts ?? '?'})`);
    return deliver(job, pending, callbackUrl, secret, deps);
  }

  if (job.kind === 'tools-trends') return processTrendsJob(job, requestId, callbackUrl, secret, deps);

  const started = Date.now();
  let subject: string;
  let outcome: ToolsOutcome | VideoOutcome;
  let doneNote: Record<string, unknown> = {};

  if (job.kind === 'tools-video') {
    const video = parseVideoPayload(payload);
    subject = video?.videoId ?? 'invalid';
    if (!video) {
      outcome = { status: 'failed', code: 'not_found' };
    } else {
      // downloadVideo meters and records its own proxy bytes against the workspace; recording again would double-bill.
      outcome = await runVideoLookup(video, deps.buildVideo(job.workspaceId));
      if (outcome.status === 'done') doneNote = { durationSec: outcome.result.durationSec, bytes: outcome.result.bytes };
    }
  } else {
    const handle = typeof payload.handle === 'string' ? payload.handle.trim().toLowerCase() : '';
    subject = `@${handle}`;
    let probe: ProfileProbe | null = null;
    let bytes = 0;
    if (!HANDLE_RE.test(handle)) {
      outcome = { status: 'failed', code: 'not_found' };
    } else {
      const full = job.kind === 'tools-profile';
      const lookup = deps.buildLookup(job.workspaceId, (p) => { probe = p; }, { fresh: full });
      const run: (h: string, d: ProfileLiteDeps) => Promise<ToolsOutcome> = full ? runProfile : runProfileLite;
      const coverFetch = full ? deps.coverFetch : undefined;
      const uploadCoversFor = coverFetch
        ? (h: string, targets: CoverTarget[]) => uploadCovers(h, targets, {
            fetch: coverFetch,
            siteUrl: (deps.env.TOOLS_SITE_URL ?? '').trim() || DEFAULT_SITE_URL,
            secret,
            nowSeconds: deps.callback.nowSeconds,
            nonce: deps.callback.nonce,
          })
        : undefined;
      const measured = await deps.measure(() => run(handle, { ...lookup, probe: () => probe, uploadCovers: uploadCoversFor }));
      outcome = measured.value;
      bytes = measured.bytes;
    }
    if (outcome.status === 'done') doneNote = { sampled: (outcome.result as { sampled: number }).sampled };
    if (bytes > 0) {
      await deps.recordBytes(job.workspaceId, bytes, requestId).catch((err: Error) => {
        console.warn(`[tools] failed to record ${bytes}B for ${requestId}: ${err.message}`);
      });
    }
  }

  // A seed/refresh has no visitor waiting, and the callback settles the lookup row for good, so a
  // transient failure stays unreported (requeued with backoff) until the last attempt.
  if (
    job.kind === 'tools-profile'
    && (payload.reason === 'seed' || payload.reason === 'refresh')
    && isTransientOutcome(outcome)
    && (job.attempts ?? QUEUE_MAX_ATTEMPTS) < QUEUE_MAX_ATTEMPTS
  ) {
    const code = outcome.status === 'failed' ? outcome.code : 'unknown';
    console.log(`[tools] ${job.kind} job ${job.id.slice(0, 8)} ${subject} -> retry:${code} attempt=${job.attempts} duration=${Date.now() - started}ms`);
    await deps.failJob(job.id, `lookup throttled: ${code}`);
    return { ok: false, error: `lookup throttled: ${code}` };
  }

  const body =
    outcome.status === 'done'
      ? { requestId, status: 'done', result: outcome.result }
      : { requestId, status: 'failed', code: outcome.code };
  return deliver(job, {
    body,
    log:
      `[tools] ${job.kind} job ${job.id.slice(0, 8)} ${subject} -> `
      + `${outcome.status === 'done' ? 'done' : `failed:${outcome.code}`} `
      + `${payload.reason === 'refresh' ? 'reason=refresh ' : ''}duration=${Date.now() - started}ms`,
    completePayload: JSON.stringify(outcome.status === 'done' ? { status: 'done', ...doneNote } : outcome),
    result: isHealthyOutcome(outcome)
      ? { ok: true }
      : { ok: false, error: `lookup failed: ${outcome.status === 'failed' ? outcome.code : 'unknown'}` },
  }, callbackUrl, secret, deps);
}

async function processTrendsJob(
  job: Pick<MediaJobRow, 'id' | 'workspaceId' | 'payloadJson'>,
  requestId: string,
  callbackUrl: string,
  secret: string,
  deps: ToolsJobDeps,
): Promise<ToolsJobResult> {
  const parsed = parseTrendsPayload(job.payloadJson);
  if ('error' in parsed) {
    await deps.failJob(job.id, parsed.error, { terminal: true });
    return { ok: false, error: parsed.error };
  }
  if (!deps.buildTrends) {
    const message = 'tools-trends is not wired on this worker';
    await deps.failJob(job.id, message, { terminal: true });
    return { ok: false, error: message };
  }

  const started = Date.now();
  const built = deps.buildTrends(job.workspaceId);
  const trends = deps.coverFetch
    ? {
        ...built,
        uploadCovers: (targets: AuthoredCoverTarget[]) => uploadTrendCovers(targets, {
          fetch: deps.coverFetch as typeof fetch,
          siteUrl: (deps.env.TOOLS_SITE_URL ?? '').trim() || DEFAULT_SITE_URL,
          secret,
          nowSeconds: deps.callback.nowSeconds,
          nonce: deps.callback.nonce,
        }),
      }
    : built;
  const measured = await deps.measure(() => runTrends(parsed, trends));
  const outcome = measured.value;
  const bytes = measured.bytes;
  if (bytes > 0) {
    await deps.recordBytes(job.workspaceId, bytes, requestId).catch((err: Error) => {
      console.warn(`[tools] failed to record ${bytes}B for ${requestId}: ${err.message}`);
    });
  }

  const body =
    outcome.status === 'done'
      ? { requestId, status: 'done', ...outcome.body }
      : { requestId, status: 'failed', code: outcome.code };
  return deliver({ id: job.id, kind: 'tools-trends' }, {
    body,
    log:
      `[tools] tools-trends job ${job.id.slice(0, 8)} -> `
      + `${outcome.status === 'done' ? `done tags=${outcome.body.hashtags.length} sampledTags=${outcome.sampledTags} posts=${outcome.body.samplePosts.length} examples=${outcome.body.exampleIds.length} covers=${outcome.body.covers.length}` : `failed:${outcome.code}`} `
      + `bytes=${bytes} duration=${Date.now() - started}ms`,
    completePayload: JSON.stringify(outcome.status === 'done'
      ? { status: 'done', hashtags: outcome.body.hashtags.length, samplePosts: outcome.body.samplePosts.length }
      : outcome),
    // A budget stop is policy working, not a broken kind; a source failure should trip the breaker.
    result: outcome.status === 'done' || outcome.code === 'budget'
      ? { ok: true }
      : { ok: false, error: `trends failed: ${outcome.code}` },
  }, callbackUrl, secret, deps);
}

/** Production wiring: real scraper, ledger, queue lifecycle and fetch. */
export async function defaultToolsJobDeps(): Promise<ToolsJobDeps> {
  const [bandwidth, budget, web, impersonate, jobs, creativeCenter] = await Promise.all([
    import('../lib/scrapers/bandwidth.js'),
    import('../lib/scrapers/budget.js'),
    import('../lib/scrapers/tiktok-web.js'),
    import('../lib/scrapers/impersonate-http.js'),
    import('../lib/jobs.js'),
    import('../lib/creative-center.js'),
  ]);
  return {
    env: process.env,
    now: () => new Date(),
    measure: (fn) =>
      bandwidth.withMeterScope(async () => {
        const value = await fn();
        return { value, bytes: bandwidth.scopeBytesUsed() };
      }),
    buildLookup: (workspaceId, onProfile, opts) => {
      let httpOnce: Promise<TikTokHttp> | null = null;
      const http = () => (httpOnce ??= impersonate.createImpersonatedHttp().then((h) => h ?? web.unsignedHttp));
      return {
        assertBudget: (estimate) => budget.assertProxyBudget(workspaceId, estimate),
        resolveCreator: async (h) => {
          if (opts?.fresh) web.forgetCreator(h);
          return web.withTikTokHttp(probingHttp(await http(), onProfile), () => web.resolveCreator(h));
        },
        fetchPosts: async (identity, limit) => {
          const { items } = await web.withTikTokHttp(await http(), () => web.fetchCreatorPosts(identity, { limit }));
          return items;
        },
        fetchEmbed: async (h, limit) => web.withTikTokHttp(await http(), () => web.fetchEmbedCreator(h, { limit })),
        hydrate: async (items) => web.withTikTokHttp(await http(), () => web.hydrateItemStats(items, PROFILE_HYDRATE_PAGES, MIN_ENGAGEMENT_POSTS)),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        oembedStatus: async (h) => {
          try {
            const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(h)}`;
            const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(profileUrl)}`, {
              signal: AbortSignal.timeout(5_000),
              headers: { accept: 'application/json' },
            });
            return res.status;
          } catch {
            return 0;
          }
        },
        now: () => new Date(),
      };
    },
    buildTrends: (workspaceId) => {
      let httpOnce: Promise<TikTokHttp> | null = null;
      const http = () => (httpOnce ??= impersonate.createImpersonatedHttp().then((h) => h ?? web.unsignedHttp));
      return {
        assertBudget: (proxyBytes) => budget.assertProxyBudget(workspaceId, proxyBytes),
        fetchHashtagList: (period, industryId) => creativeCenter.fetchHashtagList(period, industryId),
        resolveChallengeId: async (tag) => web.withTikTokHttp(await http(), () => web.resolveChallengeId(tag)),
        fetchTagPosts: async (tag, challengeId, limit) => {
          const { items } = await web.withTikTokHttp(await http(), () => web.fetchHashtagPosts(tag, challengeId, { limit }));
          return items;
        },
        now: () => new Date(),
      };
    },
    buildVideo: (workspaceId) => defaultVideoDeps(workspaceId),
    recordBytes: async (workspaceId, bytes, refId) => {
      await bandwidth.recordTrafficBytes(workspaceId, bytes, refId);
    },
    coverFetch: (input, init) => fetch(input, init),
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
