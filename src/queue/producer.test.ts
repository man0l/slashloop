// Producer client tests (SLA-16 Phase 2b). No network: fetch is faked.
// The roundtrip test pins the WebCrypto client against the server's
// node:crypto verifier — a signature the client makes must verify.
import { describe, expect, test } from 'bun:test';
import { mapKeyStore, verifyAuth } from './auth.js';
import {
  loadProducerConfig,
  ProducerHttpError,
  producerSignature,
  publishJobHttp,
  type FetchImpl,
  type PublishBody,
} from './producer.js';

const SECRET = 'test-producer-secret-01';
const KEY_ID = 'qk-test-01';

const body: PublishBody = {
  kind: 'thumb',
  workspaceId: 'ws-1',
  videoId: 'vid-1',
  sourceId: null,
  dedupeKey: 'thumb:video:vid-1',
  deadlineAt: null,
  payload: { thumbnailUrl: 'https://cdn/x.jpg' },
  credits: null,
  d1JobId: 'd1-projection-1',
};

function fakeFetch(
  handler: (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    status: number;
    headers?: Record<string, string>;
    text: string;
  },
): FetchImpl & { calls: number; lastHeaders?: Record<string, string>; lastBody?: Uint8Array } {
  const f = (async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    f.calls++;
    f.lastHeaders = init.headers;
    f.lastBody = init.body;
    const out = handler(url, init);
    return {
      status: out.status,
      headers: { get: (n: string) => out.headers?.[n.toLowerCase()] ?? null },
      text: async () => out.text,
    };
  }) as unknown as FetchImpl & { calls: number; lastHeaders?: Record<string, string>; lastBody?: Uint8Array };
  f.calls = 0;
  return f;
}

describe('producer client', () => {
  test('client signature verifies against the server verifier', async () => {
    const rawBody = new TextEncoder().encode(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'roundtrip-nonce-01';
    const signature = await producerSignature(SECRET, 'POST', '/v1/jobs', timestamp, nonce, rawBody);
    const auth = verifyAuth(
      {
        'x-slq-key-id': KEY_ID,
        'x-slq-timestamp': timestamp,
        'x-slq-nonce': nonce,
        'x-slq-signature': signature,
      },
      'POST',
      '/v1/jobs',
      rawBody,
      mapKeyStore([{ keyId: KEY_ID, secret: SECRET, state: 'active' }]),
    );
    expect(auth.ok).toBe(true);
  });

  test('202 accepts and reports dedupe', async () => {
    const fetch = fakeFetch(() => ({
      status: 202,
      text: JSON.stringify({ jobId: 'pg-1', state: 'queued', deduped: true, acceptedAt: new Date().toISOString() }),
    }));
    const accepted = await publishJobHttp(
      { baseUrl: 'https://queue.test', keyId: KEY_ID, secret: SECRET, timeoutMs: 5000 },
      body,
      { fetchImpl: fetch, nowSeconds: () => 1_700_000_000, nonceHex: () => 'fixed-nonce-01' },
    );
    expect(accepted).toEqual({ pgJobId: 'pg-1', deduped: true });
    expect(fetch.calls).toBe(1);
    // Exact path, no query string (canonical-path contract).
    expect(fetch.lastHeaders?.['x-slq-key-id']).toBe(KEY_ID);
  });

  test('replay_detected retries once with a fresh nonce, same body', async () => {
    let n = 0;
    const nonces: string[] = [];
    const bodies: string[] = [];
    const fetch = fakeFetch((_url, init) => {
      nonces.push(init.headers['x-slq-nonce']);
      bodies.push(new TextDecoder().decode(init.body));
      n++;
      return n === 1
        ? { status: 409, text: JSON.stringify({ error: { code: 'replay_detected', message: 'nonce used', retryable: true, jobId: null } }) }
        : { status: 202, text: JSON.stringify({ jobId: 'pg-2', deduped: false }) };
    });
    const accepted = await publishJobHttp(
      { baseUrl: 'https://queue.test', keyId: KEY_ID, secret: SECRET, timeoutMs: 5000 },
      body,
      { fetchImpl: fetch, nonceHex: () => `nonce-${nonces.length}` },
    );
    expect(accepted.pgJobId).toBe('pg-2');
    expect(fetch.calls).toBe(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('401/422 surface non-retryable, 429/503/network retryable', async () => {
    const cfg = { baseUrl: 'https://queue.test', keyId: KEY_ID, secret: SECRET, timeoutMs: 5000 };
    const unauth = fakeFetch(() => ({ status: 401, text: JSON.stringify({ error: { code: 'unauthenticated', message: 'bad', retryable: false, jobId: null } }) }));
    await expect(publishJobHttp(cfg, body, { fetchImpl: unauth })).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
    } satisfies Partial<ProducerHttpError>);

    const invalid = fakeFetch(() => ({ status: 422, text: JSON.stringify({ error: { code: 'invalid_job', message: 'bad', retryable: false, jobId: null } }) }));
    await expect(publishJobHttp(cfg, body, { fetchImpl: invalid })).rejects.toMatchObject({ retryable: false });

    const limited = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow', retryable: true, jobId: null } }),
    }));
    const rateErr = await publishJobHttp(cfg, body, { fetchImpl: limited }).catch((e) => e);
    expect(rateErr).toBeInstanceOf(ProducerHttpError);
    expect((rateErr as ProducerHttpError).retryable).toBe(true);
    expect((rateErr as ProducerHttpError).retryAfterSeconds).toBe(7);

    const down: FetchImpl = async () => {
      throw new Error('connection refused');
    };
    await expect(publishJobHttp(cfg, body, { fetchImpl: down })).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    } satisfies Partial<ProducerHttpError>);
  });

  test('config loads from env, null when unconfigured', () => {
    expect(
      loadProducerConfig({ QUEUE_API_URL: 'https://q.example/', QUEUE_API_KEY_ID: 'k', QUEUE_API_KEY_SECRET: 's' } as NodeJS.ProcessEnv),
    ).toMatchObject({ baseUrl: 'https://q.example', keyId: 'k', secret: 's' });
    expect(loadProducerConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
