// SLA-617: signed delivery of experiment completion events. Runs on the VPS
// worker only (it needs node:dns/https and, for Paperclip mode, an API key that
// must never live in the Cloudflare Worker).
import { createHash, createHmac } from 'node:crypto';
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
export type HttpPost = (url: URL, headers: Record<string, string>, body: string) => Promise<{ status: number }>;

const ok = (status: number): DeliveryResult => ({ ok: true, permanent: false, status, error: null });
const fail = (error: string, status: number | null = null, permanent = false): DeliveryResult => ({ ok: false, permanent, status, error });

/** 2xx delivered; 408/425/429/401/403/5xx and network errors retry; every other status is final. */
export function classifyStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return ok(status);
  const retryable = status >= 500 || [401, 403, 408, 425, 429].includes(status);
  return fail(`http_${status}`, status, !retryable);
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

/** Connect-time address check: every resolved address must be public, so DNS rebinding cannot reach the private network. */
const guardedLookup = ((hostname: string, _opts: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
  if (isIP(hostname)) {
    return isPrivateAddress(hostname) ? cb(new WebhookUrlError('blocked_address')) : cb(null, hostname, isIP(hostname));
  }
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) return cb(new WebhookUrlError('blocked_address'));
    cb(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as unknown as NonNullable<https.RequestOptions['lookup']>;

const REQUEST_TIMEOUT_MS = 10_000;

/** One POST, no redirects, response body discarded, hard timeout. */
export const guardedPost: HttpPost = (url, headers, body) => new Promise((resolve, reject) => {
  // Node never calls `lookup` for an IP literal, so the literal is checked here.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && isPrivateAddress(hostname)) return reject(new WebhookUrlError('blocked_address'));
  const req = https.request({
    protocol: 'https:', hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'POST',
    headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup: guardedLookup, timeout: REQUEST_TIMEOUT_MS,
  }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); res.on('error', reject); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  req.end(body);
});

export interface PaperclipBridge {
  baseUrl: string;
  apiKey: string;
}

/** Reads the bridge from env; null unless a public https URL and a key are set. */
export function paperclipBridgeFromEnv(env: Record<string, string | undefined> = process.env): PaperclipBridge | null {
  const baseUrl = env.SLASHLOOP_PAPERCLIP_API_URL?.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  const apiKey = (env.SLASHLOOP_PAPERCLIP_API_KEY || env.PAPERCLIP_API_KEY_FOR_SLASHLOOP_BRIDGE_AGENT)?.trim();
  if (!baseUrl || !apiKey) return null;
  try { assertPublicHttpsUrl(baseUrl); } catch { return null; }
  return { baseUrl, apiKey };
}

/** Deterministic UUID so a retried comment is the same Paperclip client request. */
export function clientRequestId(idempotencyKey: string): string {
  const h = createHash('sha256').update(`slashloop-webhook:${idempotencyKey}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function paperclipCommentBody(payload: Record<string, unknown>): string {
  const summary = (payload.summary ?? {}) as { variants?: number; spentCredits?: number };
  const lines = [
    `**slashloop experiment \`${payload.experimentId}\` is ${payload.status}.**`,
    '',
    `Variants: ${summary.variants ?? 0} · credits spent: ${summary.spentCredits ?? 0}`,
    ...(typeof payload.error === 'string' ? [`Error: ${payload.error}`] : []),
    '',
    `Call \`get_experiment\` with experimentId \`${payload.experimentId}\` to review the result.`,
  ];
  return lines.join('\n');
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
      const body = JSON.stringify({ body: paperclipCommentBody(payload), clientRequestId: clientRequestId(row.idempotencyKey) });
      const res = await post(new URL(`${bridge.baseUrl}/api/issues/${issueId}/comments`), {
        'content-type': 'application/json', authorization: `Bearer ${bridge.apiKey}`, 'idempotency-key': row.idempotencyKey,
        'user-agent': 'slashloop-webhooks/1',
      }, body);
      return classifyStatus(res.status);
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
