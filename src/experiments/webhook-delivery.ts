// SLA-617: signed delivery of experiment completion events. Runs on the VPS
// worker only (it needs node:dns/https and, for Paperclip mode, the per-agent API
// keys that must never live in the Cloudflare Worker).
import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { assertPublicHttpsUrl, isPrivateAddress, WebhookUrlError } from '../lib/webhook-url.js';
import { paperclipIssueIdOf, type NotifyConfig } from './schema.js';

export interface DeliveryResult {
  ok: boolean;
  /** A retry cannot change the outcome (bad request, gone, no key for the requesting agent). */
  permanent: boolean;
  status: number | null;
  error: string | null;
}
export type HttpPost = (url: URL, headers: Record<string, string>, body: string) => Promise<{ status: number; body?: string }>;
export type HttpGet = (url: URL, headers: Record<string, string>) => Promise<{ status: number; body?: string }>;

const ok = (status: number): DeliveryResult => ({ ok: true, permanent: false, status, error: null });
const fail = (error: string, status: number | null = null, permanent = false): DeliveryResult => ({ ok: false, permanent, status, error });

/** 2xx delivered; 408/425/429/401/403/5xx and network errors retry; every other status is final. */
export function classifyStatus(status: number, detail = ''): DeliveryResult {
  if (status >= 200 && status < 300) return ok(status);
  const retryable = status >= 500 || [401, 403, 408, 425, 429].includes(status);
  return fail(detail ? `http_${status}: ${detail}` : `http_${status}`, status, !retryable);
}

/** One-line, length-capped response snippet for `lastError`, with the agent key and anything token-shaped masked. */
export function redactedSnippet(body: string | undefined, secrets: string[] = [], max = 160): string {
  let t = (body ?? '').replace(/\s+/g, ' ').trim();
  for (const s of secrets) if (s) t = t.split(s).join('[redacted]');
  t = t.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_\-.]{24,}/g, '[redacted]');
  return t.slice(0, max);
}

/** Standard Webhooks signing: HMAC-SHA256 over `${id}.${timestamp}.${body}`; a whsec_ secret is base64 key material. */
export function signWebhook(secret: string, id: string, timestampSeconds: number, body: string): string {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`;
}

export function webhookHeaders(id: string, secret: string | null, nowMs: number, body: string): Record<string, string> {
  const ts = Math.floor(nowMs / 1000);
  return {
    'content-type': 'application/json',
    'user-agent': 'slashloop-webhooks/1',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'idempotency-key': id,
    ...(secret ? { 'webhook-signature': signWebhook(secret, id, ts, body) } : {}),
  };
}

type Resolver = (host: string, opts: { all: true }, cb: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void) => void;

/** Resolves once and returns one public address to connect to, preferring IPv4 (a worker without an IPv6 route would fail on a leading AAAA answer, and there is no happy-eyeballs fallback once the IP is pinned). Any private address among the answers blocks the host, so DNS rebinding cannot reach the private network. */
export function resolvePublic(hostname: string, resolve: Resolver = dns.lookup as unknown as Resolver): Promise<string> {
  if (isIP(hostname)) return isPrivateAddress(hostname) ? Promise.reject(new WebhookUrlError('blocked_address')) : Promise.resolve(hostname);
  return new Promise((res, rej) => resolve(hostname, { all: true }, (err, addresses) => {
    if (err) return rej(err);
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) return rej(new WebhookUrlError('blocked_address'));
    res((addresses.find(a => a.family === 4) ?? addresses[0]!).address);
  }));
}

const REQUEST_IDLE_TIMEOUT_MS = 10_000;
/** Wall-clock cap per request (DNS + connect + send + full response); the idle timeout alone lets a slow-drip endpoint hold the single-flight sweep. */
export const REQUEST_DEADLINE_MS = 15_000;

export interface PostTransport {
  request: typeof https.request;
  protocol: 'https:' | 'http:';
  /** Fixed port, or undefined to use the URL's own. */
  port?: number;
  /** Picks the address to connect to. The socket goes to that IP with the hostname as SNI/Host, so the certificate is still checked against the name. Bun's https shim ignores a custom `lookup` and `createConnection`, so the pin must be the request's own host. */
  resolve?: (hostname: string) => Promise<string>;
}
const GUARDED_HTTPS: PostTransport = { request: https.request, protocol: 'https:', port: 443, resolve: h => resolvePublic(h) };

const RESPONSE_SNIPPET_BYTES = 1024;
/** A comment listing is searched for the delivery marker, so it keeps far more than a diagnostic snippet. */
const LISTING_BYTES = 1024 * 1024;

function createGuardedRequest(method: 'POST' | 'GET', keepBytes: number, deadlineMs: number, transport: PostTransport) {
  return (url: URL, headers: Record<string, string>, body: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let settled = false;
    let req: ReturnType<typeof https.request> | undefined;
    const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(deadline); fn(); };
    // Settle before destroying so the error the destroy emits cannot win the race; the timer is a plain setTimeout because it behaves the same on Node and Bun.
    const deadline = setTimeout(() => {
      const err = Object.assign(new Error('deadline_exceeded'), { code: 'DEADLINE_EXCEEDED' });
      settle(() => reject(err));
      req?.destroy(err);
    }, deadlineMs);
    (transport.resolve ? transport.resolve(hostname) : Promise.resolve(hostname)).then(address => {
      if (settled) return;
      const pinned = address !== hostname;
      req = transport.request({
        protocol: transport.protocol, hostname: address, port: transport.port ?? url.port, path: `${url.pathname}${url.search}`, method,
        ...(pinned ? { servername: isIP(hostname) ? undefined : hostname } : {}),
        headers: { ...headers, ...(pinned ? { host: url.host } : {}), ...(method === 'POST' ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }, timeout: REQUEST_IDLE_TIMEOUT_MS,
      }, res => {
        const chunks: Buffer[] = [];
        let kept = 0;
        res.on('data', (c: Buffer) => { if (kept < keepBytes) { chunks.push(c); kept += c.length; } });
        const result = () => ({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).subarray(0, keepBytes).toString('utf8') });
        res.on('end', () => settle(() => resolve(result())));
        res.on('error', err => settle(() => reject(err)));
        res.on('close', () => settle(() => (res.complete ? resolve(result()) : reject(new Error('response_aborted')))));
      });
      req.on('timeout', () => req!.destroy(new Error('timeout')));
      req.on('error', err => settle(() => reject(err)));
      req.end(method === 'POST' ? body : undefined);
    }, err => settle(() => reject(err)));
  });
}

/** One POST, no redirects, first 1 KB of the response kept for diagnostics, idle timeout plus an overall deadline. */
export function createGuardedPost(deadlineMs: number = REQUEST_DEADLINE_MS, transport: PostTransport = GUARDED_HTTPS): HttpPost {
  return createGuardedRequest('POST', RESPONSE_SNIPPET_BYTES, deadlineMs, transport);
}
/** The same guarded transport for a GET, keeping up to 1 MB of the response. */
export function createGuardedGet(deadlineMs: number = REQUEST_DEADLINE_MS, transport: PostTransport = GUARDED_HTTPS): HttpGet {
  const request = createGuardedRequest('GET', LISTING_BYTES, deadlineMs, transport);
  return (url, headers) => request(url, headers, '');
}

export const guardedPost: HttpPost = createGuardedPost();
export const guardedGet: HttpGet = createGuardedGet();

export interface PaperclipConfig {
  baseUrl: string;
  /** Agent id -> that agent's own Paperclip API key. The comment is authored by whichever agent asked. */
  keys: Record<string, string>;
}

export type PaperclipConfigReason =
  | 'paperclip_url_missing'
  | 'paperclip_url_not_public_https'
  | 'paperclip_keys_missing'
  | 'paperclip_keys_invalid_json'
  | 'paperclip_keys_empty';
export type PaperclipConfigResult = { config: PaperclipConfig; reason: null } | { config: null; reason: PaperclipConfigReason };

export interface PaperclipConfigState {
  urlSet: boolean;
  keyCount: number;
  agentIds: string[];
  /** First fault found, null when delivery can run. */
  reason: PaperclipConfigReason | null;
  config: PaperclipConfig | null;
}

/** Inspects SLASHLOOP_PAPERCLIP_API_URL (public https) and SLASHLOOP_PAPERCLIP_AGENT_KEYS (JSON `{agentId: key}`); every fault is retryable, the reason says which one. */
export function inspectPaperclipEnv(env: Record<string, string | undefined> = process.env): PaperclipConfigState {
  const baseUrl = env.SLASHLOOP_PAPERCLIP_API_URL?.trim().replace(/\/+$/, '').replace(/\/api$/, '') ?? '';
  let urlReason: PaperclipConfigReason | null = null;
  if (!baseUrl) urlReason = 'paperclip_url_missing';
  else { try { assertPublicHttpsUrl(baseUrl); } catch { urlReason = 'paperclip_url_not_public_https'; } }

  const rawKeys = env.SLASHLOOP_PAPERCLIP_AGENT_KEYS?.trim() ?? '';
  const keys: Record<string, string> = {};
  let keysReason: PaperclipConfigReason | null = null;
  if (!rawKeys) keysReason = 'paperclip_keys_missing';
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(rawKeys); } catch { parsed = undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) keysReason = 'paperclip_keys_invalid_json';
    else {
      for (const [agentId, key] of Object.entries(parsed)) {
        if (typeof key === 'string' && key.trim()) keys[agentId.trim()] = key.trim();
      }
      if (!Object.keys(keys).length) keysReason = 'paperclip_keys_empty';
    }
  }

  const reason = urlReason ?? keysReason;
  return {
    urlSet: Boolean(baseUrl),
    keyCount: Object.keys(keys).length,
    agentIds: Object.keys(keys),
    reason,
    config: reason ? null : { baseUrl, keys },
  };
}

export function paperclipConfigFromEnv(env: Record<string, string | undefined> = process.env): PaperclipConfigResult {
  const { config, reason } = inspectPaperclipEnv(env);
  return config ? { config, reason: null } : { config: null, reason: reason! };
}

/** One startup line: what the worker can see of the Paperclip delivery env. Agent ids only, never key values. */
export function describePaperclipEnv(env: Record<string, string | undefined> = process.env): string {
  const s = inspectPaperclipEnv(env);
  return `paperclip delivery config: url=${s.urlSet ? 'set' : 'unset'} keys=${s.keyCount} agents=[${s.agentIds.join(', ')}] status=${s.reason ?? 'ok'}`;
}

/** Hidden line that makes a delivery recognisable in the issue thread: one per (experiment, terminal status, version). */
export function paperclipMarker(deliveryKey: string): string {
  return `<!-- slashloop-experiment:${deliveryKey} -->`;
}

export function paperclipCommentBody(payload: Record<string, unknown>, marker: string): string {
  const summary = (payload.summary ?? {}) as { variants?: number; spentCredits?: number };
  const error = typeof payload.error === 'string' ? payload.error.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim() : '';
  return [
    `Slashloop experiment \`${payload.experimentId}\` reached **${payload.status}**.`,
    '',
    `Variants: ${summary.variants ?? 0} · credits spent: ${summary.spentCredits ?? 0}`,
    ...(error ? [`Error: ${error}`] : []),
    '',
    `Call \`get_experiment\` with experimentId \`${payload.experimentId}\` to review the result.`,
    '',
    marker,
  ].join('\n');
}

/** 2xx delivered; 401 and 408/425/429/5xx retry (a key can be fixed, a server can recover); 403, 404 and every other status are final. */
export function classifyCommentStatus(status: number, detail = ''): DeliveryResult {
  if (status >= 200 && status < 300) return ok(status);
  const retryable = status >= 500 || [401, 408, 425, 429].includes(status);
  return fail(detail ? `http_${status}: ${detail}` : `http_${status}`, status, !retryable);
}

export interface DeliverDeps {
  post?: HttpPost;
  get?: HttpGet;
  /** Undefined reads `paperclipEnv` (default process.env). */
  paperclip?: PaperclipConfig;
  paperclipEnv?: Record<string, string | undefined>;
  now?: () => number;
}

/** Posts one comment on the originating issue as the requesting agent; a marker already in the thread means a previous attempt landed. */
async function deliverPaperclipComment(
  deliveryKey: string, issueId: string, notify: NotifyConfig, payload: Record<string, unknown>, deps: DeliverDeps,
): Promise<DeliveryResult> {
  const post = deps.post ?? guardedPost;
  const get = deps.get ?? guardedGet;
  const resolved: PaperclipConfigResult = deps.paperclip ? { config: deps.paperclip, reason: null } : paperclipConfigFromEnv(deps.paperclipEnv);
  if (!resolved.config) return fail(resolved.reason, null, false);
  const config = resolved.config;
  const agentId = typeof notify.metadata?.agentId === 'string' ? notify.metadata.agentId.trim() : '';
  const apiKey = agentId && Object.hasOwn(config.keys, agentId) ? config.keys[agentId] : undefined;
  if (!apiKey) return fail(agentId ? 'paperclip_agent_key_missing' : 'paperclip_agent_id_missing', null, true);
  const headers = { authorization: `Bearer ${apiKey}`, 'user-agent': 'slashloop-webhooks/1' };
  const commentsUrl = `${config.baseUrl}/api/issues/${encodeURIComponent(issueId)}/comments`;
  const marker = paperclipMarker(deliveryKey);

  // Server-side clientRequestId dedupe covers user actors only, so the thread itself is the idempotency record.
  const listing = await get(new URL(`${commentsUrl}?order=desc&limit=100`), headers);
  if (listing.status < 200 || listing.status >= 300) return classifyCommentStatus(listing.status, redactedSnippet(listing.body, [apiKey]));
  if ((listing.body ?? '').includes(marker)) return ok(listing.status);

  // `resume` is what wakes the assignee on its own comment; the worker sends no run id, so it is never "the current run".
  const body = JSON.stringify({ body: paperclipCommentBody(payload, marker), resume: true });
  const res = await post(new URL(commentsUrl), { ...headers, 'content-type': 'application/json' }, body);
  return classifyCommentStatus(res.status, redactedSnippet(res.body, [apiKey]));
}

/** Delivers one outbox event to its configured target. Never throws. */
export async function deliver(
  row: { idempotencyKey: string; workspaceId: string; notifyJson: string; payloadJson: string },
  deps: DeliverDeps = {},
): Promise<DeliveryResult> {
  const post = deps.post ?? guardedPost;
  const now = deps.now ?? Date.now;
  let notify: NotifyConfig;
  let payload: Record<string, unknown>;
  try {
    notify = JSON.parse(row.notifyJson) as NotifyConfig;
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch { return fail('corrupt_outbox_row', null, true); }
  try {
    const issueId = paperclipIssueIdOf(notify.metadata);
    if (issueId) return await deliverPaperclipComment(row.idempotencyKey, issueId, notify, payload, deps);
    if (!notify.url) return fail('no_target', null, true);
    const url = assertPublicHttpsUrl(notify.url);
    const body = JSON.stringify({ ...payload, ...(notify.metadata ? { metadata: notify.metadata } : {}) });
    const res = await post(url, webhookHeaders(row.idempotencyKey, notify.secret, now(), body), body);
    return classifyStatus(res.status);
  } catch (err) {
    if (err instanceof WebhookUrlError) return fail(err.code, null, true);
    const code = (err as { code?: string }).code;
    return fail(`network_error:${code ?? (err as Error).message ?? 'unknown'}`.slice(0, 200));
  }
}
