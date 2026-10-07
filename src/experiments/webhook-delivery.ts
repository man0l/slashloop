// SLA-617: signed delivery of experiment completion events. Runs on the VPS
// worker only (it needs node:dns/https and, for Paperclip mode, an API key that
// must never live in the Cloudflare Worker).
import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { assertPublicHttpsUrl, isPrivateAddress, WebhookUrlError } from '../lib/webhook-url.js';
import { paperclipIssueIdOf, type NotifyConfig } from './schema.js';

export interface DeliveryResult {
  ok: boolean;
  /** A retry cannot change the outcome (bad request, gone, no bridge for this workspace). */
  permanent: boolean;
  status: number | null;
  error: string | null;
}
export type HttpPost = (url: URL, headers: Record<string, string>, body: string) => Promise<{ status: number; body?: string }>;

const ok = (status: number): DeliveryResult => ({ ok: true, permanent: false, status, error: null });
const fail = (error: string, status: number | null = null, permanent = false): DeliveryResult => ({ ok: false, permanent, status, error });

/** 2xx delivered; 408/425/429/401/403/5xx and network errors retry; every other status is final. */
export function classifyStatus(status: number, detail = ''): DeliveryResult {
  if (status >= 200 && status < 300) return ok(status);
  const retryable = status >= 500 || [401, 403, 408, 425, 429].includes(status);
  return fail(detail ? `http_${status}: ${detail}` : `http_${status}`, status, !retryable);
}

/** One-line, length-capped response snippet for `lastError`, with the bridge key and anything token-shaped masked. */
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

/** One POST, no redirects, first 1 KB of the response kept for diagnostics, idle timeout plus an overall deadline. */
export function createGuardedPost(deadlineMs: number = REQUEST_DEADLINE_MS, transport: PostTransport = GUARDED_HTTPS): HttpPost {
  return (url, headers, body) => new Promise((resolve, reject) => {
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
        protocol: transport.protocol, hostname: address, port: transport.port ?? url.port, path: `${url.pathname}${url.search}`, method: 'POST',
        ...(pinned ? { servername: isIP(hostname) ? undefined : hostname } : {}),
        headers: { ...headers, ...(pinned ? { host: url.host } : {}), 'content-length': String(Buffer.byteLength(body)) }, timeout: REQUEST_IDLE_TIMEOUT_MS,
      }, res => {
        const chunks: Buffer[] = [];
        let kept = 0;
        res.on('data', (c: Buffer) => { if (kept < RESPONSE_SNIPPET_BYTES) { chunks.push(c); kept += c.length; } });
        const result = () => ({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).subarray(0, RESPONSE_SNIPPET_BYTES).toString('utf8') });
        res.on('end', () => settle(() => resolve(result())));
        res.on('error', err => settle(() => reject(err)));
        res.on('close', () => settle(() => (res.complete ? resolve(result()) : reject(new Error('response_aborted')))));
      });
      req.on('timeout', () => req!.destroy(new Error('timeout')));
      req.on('error', err => settle(() => reject(err)));
      req.end(body);
    }, err => settle(() => reject(err)));
  });
}

export const guardedPost: HttpPost = createGuardedPost();

export interface PaperclipBridge {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  /** Delivery project; must be inside the bridge key's `projectIds` scope. */
  projectId: string;
  /** Agent woken by the created issue; must be in the key's `allowedAssigneeAgentIds`. */
  assigneeAgentId: string;
}

/** Reads the bridge from env; null unless a public https URL, the key and the three target ids are set. */
export function paperclipBridgeFromEnv(env: Record<string, string | undefined> = process.env): PaperclipBridge | null {
  const baseUrl = env.SLASHLOOP_PAPERCLIP_API_URL?.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  const apiKey = (env.SLASHLOOP_PAPERCLIP_API_KEY || env.PAPERCLIP_API_KEY_FOR_SLASHLOOP_BRIDGE_AGENT)?.trim();
  const companyId = env.SLASHLOOP_PAPERCLIP_COMPANY_ID?.trim();
  const projectId = env.SLASHLOOP_PAPERCLIP_PROJECT_ID?.trim();
  const assigneeAgentId = env.SLASHLOOP_PAPERCLIP_ASSIGNEE_AGENT_ID?.trim();
  if (!baseUrl || !apiKey || !companyId || !projectId || !assigneeAgentId) return null;
  try { assertPublicHttpsUrl(baseUrl); } catch { return null; }
  return { baseUrl, apiKey, companyId, projectId, assigneeAgentId };
}

/** Stable per (experiment, terminal status, version): a retry or replay is the same Paperclip issue. */
export function paperclipIdempotencyKey(deliveryKey: string): string {
  return `slashloop-experiment:${deliveryKey}`.slice(0, 240);
}

export function paperclipIssueTitle(payload: Record<string, unknown>): string {
  return `Slashloop experiment ${String(payload.experimentId).slice(0, 8)} ${payload.status}`;
}

export function paperclipIssueDescription(payload: Record<string, unknown>, referenceIssueId: string | null): string {
  const summary = (payload.summary ?? {}) as { variants?: number; spentCredits?: number };
  return [
    `Slashloop experiment \`${payload.experimentId}\` reached **${payload.status}**.`,
    '',
    `Variants: ${summary.variants ?? 0} · credits spent: ${summary.spentCredits ?? 0}`,
    ...(typeof payload.error === 'string' ? [`Error: ${payload.error}`] : []),
    ...(referenceIssueId ? ['', `Requested for issue: ${referenceIssueId}`] : []),
    '',
    `Call \`get_experiment\` with experimentId \`${payload.experimentId}\` to review the result.`,
  ].join('\n');
}

export interface DeliverDeps {
  post?: HttpPost;
  bridge?: PaperclipBridge | null;
  now?: () => number;
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
    if (issueId) {
      const bridge = deps.bridge === undefined ? paperclipBridgeFromEnv() : deps.bridge;
      if (!bridge) return fail('paperclip_bridge_not_configured', null, false);
      const body = JSON.stringify({
        title: paperclipIssueTitle(payload),
        description: paperclipIssueDescription(payload, issueId),
        projectId: bridge.projectId,
        assigneeAgentId: bridge.assigneeAgentId,
        idempotencyKey: paperclipIdempotencyKey(row.idempotencyKey),
      });
      const res = await post(new URL(`${bridge.baseUrl}/api/companies/${encodeURIComponent(bridge.companyId)}/issues`), {
        'content-type': 'application/json', authorization: `Bearer ${bridge.apiKey}`, 'idempotency-key': row.idempotencyKey,
        'user-agent': 'slashloop-webhooks/1',
      }, body);
      // A 2xx is delivered whether the issue was created or the server deduplicated it (idempotency_key or recent_open_title).
      return classifyStatus(res.status, redactedSnippet(res.body, [bridge.apiKey]));
    }
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
