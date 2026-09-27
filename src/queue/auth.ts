// ---------------------------------------------------------------------------
// queue-api request authentication — exact canonical-path/raw-body HMAC.
//
// Headers:
//   X-SLQ-Key-Id, X-SLQ-Timestamp (unix seconds UTC), X-SLQ-Nonce (128-bit),
//   X-SLQ-Signature (base64url HMAC-SHA256 over the canonical string)
//
// Canonical string (exact — every \n is load-bearing):
//   METHOD\n\nCANONICAL_PATH\n\nTIMESTAMP\n\nNONCE\n\nSHA256_HEX(raw_body)
//
// Rules (plan rev 4 §Authentication):
// - skew > ±5 min rejects; signature is checked BEFORE business validation;
// - each nonce is usable once (duplicate (key_id, nonce) -> 409);
// - two usable keys during rotation: `active` signs new requests, `retiring`
//   verifies only for the overlap window. `revoked` never verifies.
// - secrets are never logged (this module has no logging at all).
// ---------------------------------------------------------------------------

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { QUEUE_AUTH_SKEW_SECONDS } from './contract.js';

export const SLQ_HEADERS = {
  keyId: 'x-slq-key-id',
  timestamp: 'x-slq-timestamp',
  nonce: 'x-slq-nonce',
  signature: 'x-slq-signature',
} as const;

export type ProducerKeyState = 'active' | 'retiring' | 'revoked';

export interface ProducerKey {
  keyId: string;
  secret: string;
  state: ProducerKeyState;
  /** Workspace ids this key may publish for; '*' means all. */
  workspaceIds?: string[] | '*';
}

export interface KeyStore {
  getKey(keyId: string): ProducerKey | undefined;
}

export function sha256Hex(rawBody: Uint8Array | string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** Build the exact canonical string that is signed. */
export function canonicalString(
  method: string,
  canonicalPath: string,
  timestamp: string,
  nonce: string,
  rawBody: Uint8Array | string,
): string {
  return (
    `${method.toUpperCase()}\n\n` +
    `${canonicalPath}\n\n` +
    `${timestamp}\n\n` +
    `${nonce}\n\n` +
    sha256Hex(rawBody)
  );
}

/** base64url HMAC-SHA256 (no padding). */
export function hmacSign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url');
}

/** Client-side helper (producer + tests): sign a request. */
export function signRequest(
  secret: string,
  method: string,
  canonicalPath: string,
  timestamp: string,
  nonce: string,
  rawBody: Uint8Array | string,
): string {
  return hmacSign(secret, canonicalString(method, canonicalPath, timestamp, nonce, rawBody));
}

export type AuthFailureReason =
  | 'missing_headers'
  | 'unknown_key'
  | 'key_revoked'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_signature';

export interface AuthSuccess {
  ok: true;
  key: ProducerKey;
  timestamp: string;
  nonce: string;
}

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify auth headers against the raw body. Pure: no I/O, no nonce storage —
 * the caller inserts the nonce atomically with the business transaction.
 */
export function verifyAuth(
  headers: Record<string, string | undefined>,
  method: string,
  canonicalPath: string,
  rawBody: Uint8Array | string,
  keys: KeyStore,
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthSuccess | AuthFailure {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const keyId = lower[SLQ_HEADERS.keyId];
  const timestamp = lower[SLQ_HEADERS.timestamp];
  const nonce = lower[SLQ_HEADERS.nonce];
  const signature = lower[SLQ_HEADERS.signature];
  if (!keyId || !timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }
  const key = keys.getKey(keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (key.state === 'revoked') return { ok: false, reason: 'key_revoked' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const skew = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(skew) || skew > QUEUE_AUTH_SKEW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  // Retiring keys still verify (overlap window); only `active` signs new
  // requests — enforced by the producer, not the verifier.
  const expected = hmacSign(
    key.secret,
    canonicalString(method, canonicalPath, timestamp, nonce, rawBody),
  );
  if (!safeEqualString(signature, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, key, timestamp, nonce };
}

/** Workspace authorization for a key (cancel/GET are workspace-scoped). */
export function keyMayAccessWorkspace(key: ProducerKey, workspaceId: string): boolean {
  const scope = key.workspaceIds ?? '*';
  if (scope === '*') return true;
  return scope.includes(workspaceId);
}

/** In-memory KeyStore for the server (loaded from env/secrets at boot). */
export function mapKeyStore(keys: ProducerKey[]): KeyStore {
  const byId = new Map(keys.map((k) => [k.keyId, k]));
  return { getKey: (keyId) => byId.get(keyId) };
}
