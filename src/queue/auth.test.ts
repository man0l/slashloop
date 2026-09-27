// Fast unit tests: HMAC canonical string, skew, kid states, raw-body fidelity.
// No database.
import { describe, expect, test } from 'bun:test';
import {
  canonicalString,
  hmacSign,
  keyMayAccessWorkspace,
  mapKeyStore,
  sha256Hex,
  signRequest,
  verifyAuth,
} from './auth.js';

const SECRET = 'test-secret-rotation-safe';
const KEYS = mapKeyStore([
  { keyId: 'active-1', secret: SECRET, state: 'active' },
  { keyId: 'old-9', secret: 'old-secret', state: 'retiring' },
  { keyId: 'dead-0', secret: 'dead-secret', state: 'revoked' },
]);

const NOW = 1_800_000_000;

function headersFor(opts: {
  keyId?: string;
  secret?: string;
  timestamp?: string;
  nonce?: string;
  method?: string;
  path?: string;
  body?: string;
}) {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/v1/jobs';
  const timestamp = opts.timestamp ?? String(NOW);
  const nonce = opts.nonce ?? 'nonce-128-bit-identifier-0001';
  const body = opts.body ?? '{"kind":"analyze"}';
  const sig = signRequest(opts.secret ?? SECRET, method, path, timestamp, nonce, body);
  const headers: Record<string, string> = {
    'X-SLQ-Key-Id': opts.keyId ?? 'active-1',
    'X-SLQ-Timestamp': timestamp,
    'X-SLQ-Nonce': nonce,
    'X-SLQ-Signature': sig,
  };
  return { headers, method, path, timestamp, nonce, body };
}

describe('canonical string', () => {
  test('exact format: METHOD, PATH, TS, NONCE, SHA256_HEX joined by blank lines', () => {
    const body = '{"a":1}';
    expect(canonicalString('POST', '/v1/jobs', '123', 'n', body)).toBe(
      `POST\n\n/v1/jobs\n\n123\n\nn\n\n${sha256Hex(body)}`,
    );
  });

  test('method uppercased; path is exact (query strings change the digest)', () => {
    const a = canonicalString('post', '/v1/jobs', '1', 'n', '{}');
    const b = canonicalString('POST', '/v1/jobs', '1', 'n', '{}');
    expect(a).toBe(b);
    expect(canonicalString('POST', '/v1/jobs?x=1', '1', 'n', '{}')).not.toBe(
      canonicalString('POST', '/v1/jobs', '1', 'n', '{}'),
    );
  });

  test('raw-body preservation: whitespace/reordering changes the signature', () => {
    const s1 = signRequest(SECRET, 'POST', '/v1/jobs', '1', 'n', '{"a":1,"b":2}');
    const s2 = signRequest(SECRET, 'POST', '/v1/jobs', '1', 'n', '{"b":2,"a":1}');
    const s3 = signRequest(SECRET, 'POST', '/v1/jobs', '1', 'n', '{"a": 1, "b": 2}');
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(s3);
  });
});

describe('verifyAuth', () => {
  test('happy path', () => {
    const { headers, method, path, body } = headersFor({});
    const out = verifyAuth(headers, method, path, body, KEYS, NOW);
    expect(out.ok).toBe(true);
  });

  test('timestamp skew ±5 min enforced', () => {
    const fresh = headersFor({ timestamp: String(NOW + 5 * 60) });
    expect(verifyAuth(fresh.headers, fresh.method, fresh.path, fresh.body, KEYS, NOW).ok).toBe(true);
    const stale = headersFor({ timestamp: String(NOW - 5 * 60 - 1) });
    const out = verifyAuth(stale.headers, stale.method, stale.path, stale.body, KEYS, NOW);
    expect(out).toEqual({ ok: false, reason: 'stale_timestamp' });
    const future = headersFor({ timestamp: String(NOW + 5 * 60 + 1) });
    expect(verifyAuth(future.headers, future.method, future.path, future.body, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
    const bad = headersFor({ timestamp: 'not-a-number' });
    expect(verifyAuth(bad.headers, bad.method, bad.path, bad.body, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    });
  });

  test('signature mismatch, unknown kid, revoked kid', () => {
    const wrong = headersFor({ secret: 'wrong-secret' });
    expect(verifyAuth(wrong.headers, wrong.method, wrong.path, wrong.body, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const unknown = headersFor({ keyId: 'nope' });
    expect(verifyAuth(unknown.headers, unknown.method, unknown.path, unknown.body, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    const revoked = headersFor({ keyId: 'dead-0', secret: 'dead-secret' });
    expect(verifyAuth(revoked.headers, revoked.method, revoked.path, revoked.body, KEYS, NOW)).toEqual({
      ok: false,
      reason: 'key_revoked',
    });
  });

  test('retiring kid still verifies (rotation overlap)', () => {
    const retiring = headersFor({ keyId: 'old-9', secret: 'old-secret' });
    const out = verifyAuth(retiring.headers, retiring.method, retiring.path, retiring.body, KEYS, NOW);
    expect(out.ok).toBe(true);
  });

  test('missing headers + tampered body', () => {
    const { headers, method, path } = headersFor({});
    expect(verifyAuth({}, method, path, '{}', KEYS, NOW)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(verifyAuth(headers, method, path, '{"kind":"refresh"}', KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Wrong canonical path (e.g. trailing slash) invalidates the signature.
    expect(verifyAuth(headers, method, '/v1/jobs/', '{"kind":"analyze"}', KEYS, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('hmac output is base64url without padding', () => {
    expect(hmacSign(SECRET, 'x')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('keyMayAccessWorkspace', () => {
  test('wildcard vs scoped keys', () => {
    expect(keyMayAccessWorkspace({ keyId: 'a', secret: 's', state: 'active' }, 'ws-1')).toBe(true);
    expect(
      keyMayAccessWorkspace({ keyId: 'a', secret: 's', state: 'active', workspaceIds: ['ws-1'] }, 'ws-1'),
    ).toBe(true);
    expect(
      keyMayAccessWorkspace({ keyId: 'a', secret: 's', state: 'active', workspaceIds: ['ws-1'] }, 'ws-2'),
    ).toBe(false);
  });
});
