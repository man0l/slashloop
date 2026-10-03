// Producer client tests (SLA-16 Phase 2b). No network: fetch is faked.
// The roundtrip test pins the WebCrypto client against the server's
// node:crypto verifier — a signature the client makes must verify.
import { describe, expect, test } from 'bun:test';
import { mapKeyStore, verifyAuth } from './auth.js';
import {
  DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS,
  DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS,
  isRateLimitedError,
  loadProducerConfig,
  ProducerHttpError,
  producerSignature,
  publishJobHttp,
  type FetchImpl,
  type PublishBody,
} from './producer.js';
import { QueuePublishError } from './publisher.js';

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
    // Budget 0 so this stays a classification test: with a budget the 429 case
    // waits out `retry-after` instead of surfacing (see the retry-after cases
    // below and the reconciler's deliberate 0).
    const noWait = { rateLimitWaitBudgetMs: 0 };
    const unauth = fakeFetch(() => ({ status: 401, text: JSON.stringify({ error: { code: 'unauthenticated', message: 'bad', retryable: false, jobId: null } }) }));
    await expect(publishJobHttp(cfg, body, { fetchImpl: unauth, ...noWait })).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
    } satisfies Partial<ProducerHttpError>);

    const invalid = fakeFetch(() => ({ status: 422, text: JSON.stringify({ error: { code: 'invalid_job', message: 'bad', retryable: false, jobId: null } }) }));
    await expect(publishJobHttp(cfg, body, { fetchImpl: invalid, ...noWait })).rejects.toMatchObject({ retryable: false });

    const limited = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow', retryable: true, jobId: null } }),
    }));
    const rateErr = await publishJobHttp(cfg, body, { fetchImpl: limited, ...noWait }).catch((e) => e);
    expect(rateErr).toBeInstanceOf(ProducerHttpError);
    expect((rateErr as ProducerHttpError).retryable).toBe(true);
    expect((rateErr as ProducerHttpError).retryAfterSeconds).toBe(7);

    const down: FetchImpl = async () => {
      throw new Error('connection refused');
    };
    await expect(publishJobHttp(cfg, body, { fetchImpl: down, ...noWait })).rejects.toMatchObject({
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

// SLA-349: the retry-after header was parsed into ProducerHttpError and then
// never read, so the wait queue-api asked for happened nowhere. Measured on
// 2026-10-01: 34 rescore publishes inside 9.5s came back as an 8m08s staircase
// because each refused publish parked its row instead of waiting out a window.
describe('producer honours retry-after', () => {
  const cfg = { baseUrl: 'https://queue.test', keyId: KEY_ID, secret: SECRET, timeoutMs: 5000 };

  /** Records every sleep the client asked for; no wall-clock time passes. */
  function fakeSleep() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
  }

  test('a 429 waits exactly retry-after seconds, then publishes', async () => {
    let n = 0;
    const nonces: string[] = [];
    const bodies: string[] = [];
    const fetch = fakeFetch((_url, init) => {
      nonces.push(init.headers['x-slq-nonce']);
      bodies.push(new TextDecoder().decode(init.body));
      n++;
      return n === 1
        ? {
            status: 429,
            headers: { 'retry-after': '7' },
            text: JSON.stringify({ error: { code: 'rate_limited', message: 'per-kind publish limit exceeded', retryable: true, jobId: null } }),
          }
        : { status: 202, text: JSON.stringify({ jobId: 'pg-3', deduped: false }) };
    });
    const { slept, sleep } = fakeSleep();
    // Pinned jitter: this case asserts the wait queue-api named, verbatim.
    const accepted = await publishJobHttp(cfg, body, {
      fetchImpl: fetch,
      sleep,
      jitterMs: () => 0,
      nonceHex: () => `nonce-${nonces.length}`,
    });

    expect(accepted).toEqual({ pgJobId: 'pg-3', deduped: false });
    expect(slept).toEqual([7000]);
    expect(fetch.calls).toBe(2);
    // The retry is a new signed request for the SAME job: fresh nonce (a 429
    // is refused before the nonce is consumed, so this is belt-and-braces),
    // byte-identical body and therefore the same dedupe key.
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('no retry-after header falls back to one limiter window', async () => {
    let n = 0;
    const fetch = fakeFetch(() => {
      n++;
      return n === 1
        ? { status: 429, text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }) }
        : { status: 202, text: JSON.stringify({ jobId: 'pg-4', deduped: false }) };
    });
    const { slept, sleep } = fakeSleep();
    const accepted = await publishJobHttp(cfg, body, {
      fetchImpl: fetch,
      sleep,
      jitterMs: () => 0, // pinned: asserts the window fallback verbatim
    });
    expect(accepted.pgJobId).toBe('pg-4');
    // DEFAULT_RATE_LIMITS are all per-minute and memoryRateLimiter's window
    // default is 60s, so a missing header means "come back in a minute".
    expect(slept).toEqual([DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS * 1000]);
  });

  test('waits accumulate across a 429 burst, and stop at the budget', async () => {
    const fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'per-workspace publish limit exceeded', retryable: true, jobId: null } }),
    }));
    const { slept, sleep } = fakeSleep();
    const err = await publishJobHttp(
      cfg,
      body,
      { fetchImpl: fetch, sleep, rateLimitWaitBudgetMs: 65_000, jitterMs: () => 0 },
    ).catch((e) => e);

    // 30s + 30s fits, a third does not: the wait is never truncated into a
    // guaranteed second 429, it surfaces and the caller parks the row.
    expect(slept).toEqual([30_000, 30_000]);
    expect(fetch.calls).toBe(3);
    expect((err as ProducerHttpError).code).toBe('rate_limited');
    expect((err as ProducerHttpError).retryAfterSeconds).toBe(30);
    expect(isRateLimitedError(err)).toBe(true);
  });

  // SLA-354: publishers refused at the same moment all retry at the same
  // window edge. The jitter spreads that retry, and the spread must stay
  // inside the budget so a legal retry-after can never be parked by it.
  test('maximum jitter on a full-window retry-after still fits the default budget', async () => {
    let n = 0;
    const fetch = fakeFetch(() => {
      n++;
      return n === 1
        ? {
            status: 429,
            headers: { 'retry-after': '60' },
            text: JSON.stringify({ error: { code: 'rate_limited', message: 'per-kind publish limit exceeded', retryable: true, jobId: null } }),
          }
        : { status: 202, text: JSON.stringify({ jobId: 'pg-6', deduped: false }) };
    });
    const { slept, sleep } = fakeSleep();
    const accepted = await publishJobHttp(cfg, body, {
      fetchImpl: fetch,
      sleep,
      jitterMs: () => DEFAULT_RATE_LIMIT_WAIT_JITTER_MAX_MS,
    });
    expect(accepted.pgJobId).toBe('pg-6');
    // 60s + 3s is the worst legal case and still fits the default 65s budget.
    expect(slept).toEqual([63_000]);
    expect(fetch.calls).toBe(2);
  });

  test('jitter that does not fit the budget surfaces instead of sleeping', async () => {
    const fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }),
    }));
    const { slept, sleep } = fakeSleep();
    // The budget holds the bare 7s wait but not 7s + 5s of jitter: the
    // publish must not sleep toward a guaranteed second 429 — it surfaces
    // and the caller parks the row for the reconciler.
    await expect(
      publishJobHttp(cfg, body, {
        fetchImpl: fetch,
        sleep,
        rateLimitWaitBudgetMs: 7_001,
        jitterMs: () => 5_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' } satisfies Partial<ProducerHttpError>);
    expect(slept).toEqual([]);
    expect(fetch.calls).toBe(1);
  });

  test('a retry-after larger than the budget surfaces instead of sleeping', async () => {
    const fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '3600' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }),
    }));
    const { slept, sleep } = fakeSleep();
    // Absurd header: the publish must not pin the caller for an hour.
    await expect(
      publishJobHttp(cfg, body, { fetchImpl: fetch, sleep, rateLimitWaitBudgetMs: 10_000 }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 3600 } satisfies Partial<ProducerHttpError>);
    expect(slept).toEqual([]);
    expect(fetch.calls).toBe(1);
  });

  test('budget 0 never waits — that is the reconciler path', async () => {
    const fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '1' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }),
    }));
    const { slept, sleep } = fakeSleep();
    await expect(
      publishJobHttp(cfg, body, { fetchImpl: fetch, sleep, rateLimitWaitBudgetMs: 0 }),
    ).rejects.toMatchObject({ code: 'rate_limited' } satisfies Partial<ProducerHttpError>);
    expect(slept).toEqual([]);
    expect(fetch.calls).toBe(1);
  });

  test('the deployment budget comes from env and applies when no call overrides it', async () => {
    // api/mcp.ts runs on Vercel with maxDuration 60, so that deployment cannot
    // afford to hold a caller for a limiter window. QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS=0
    // turns the wait off there and the behaviour is exactly what it was before.
    expect(loadProducerConfig({ QUEUE_API_KEY_ID: 'k', QUEUE_API_KEY_SECRET: 's' } as NodeJS.ProcessEnv)?.rateLimitWaitBudgetMs).toBeUndefined();
    expect(
      loadProducerConfig({ QUEUE_API_KEY_ID: 'k', QUEUE_API_KEY_SECRET: 's', QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS: '0' } as NodeJS.ProcessEnv)?.rateLimitWaitBudgetMs,
    ).toBe(0);
    expect(
      loadProducerConfig({ QUEUE_API_KEY_ID: 'k', QUEUE_API_KEY_SECRET: 's', QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS: ' 2500 ' } as NodeJS.ProcessEnv)?.rateLimitWaitBudgetMs,
    ).toBe(2500);
    // Garbage falls back to the built-in default rather than to "never wait".
    expect(
      loadProducerConfig({ QUEUE_API_KEY_ID: 'k', QUEUE_API_KEY_SECRET: 's', QUEUE_API_RATE_LIMIT_WAIT_BUDGET_MS: 'soon' } as NodeJS.ProcessEnv)?.rateLimitWaitBudgetMs,
    ).toBeUndefined();

    const fetch = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '60' },
      text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }),
    }));
    const { slept, sleep } = fakeSleep();
    await expect(
      publishJobHttp({ ...cfg, rateLimitWaitBudgetMs: 0 }, body, { fetchImpl: fetch, sleep }),
    ).rejects.toMatchObject({ code: 'rate_limited' } satisfies Partial<ProducerHttpError>);
    expect(slept).toEqual([]);
    expect(fetch.calls).toBe(1);
  });

  test('a 429 after the wait does not consume the replay budget', async () => {
    let n = 0;
    const fetch = fakeFetch(() => {
      n++;
      if (n === 1) {
        return { status: 409, text: JSON.stringify({ error: { code: 'replay_detected', message: 'nonce used', retryable: true, jobId: null } }) };
      }
      if (n === 2) {
        return { status: 429, headers: { 'retry-after': '2' }, text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryable: true, jobId: null } }) };
      }
      return { status: 202, text: JSON.stringify({ jobId: 'pg-5', deduped: false }) };
    });
    const { slept, sleep } = fakeSleep();
    const accepted = await publishJobHttp(cfg, body, {
      fetchImpl: fetch,
      sleep,
      jitterMs: () => 0, // pinned: asserts the 2s wait verbatim
    });
    expect(accepted.pgJobId).toBe('pg-5');
    // Two independent loops: the replay was retried before the wait existed,
    // and the post-wait retry is still a first-class attempt.
    expect(slept).toEqual([2000]);
    expect(fetch.calls).toBe(3);
  });

  test('isRateLimitedError sees through a wrapped publish error', () => {
    expect(isRateLimitedError(new ProducerHttpError('rate_limited', 'slow', { status: 429, retryable: true }))).toBe(true);
    expect(isRateLimitedError(new ProducerHttpError('invalid_job', 'bad', { status: 422, retryable: false }))).toBe(false);
    // QueuePublishError carries the transport code rather than erasing it.
    expect(
      isRateLimitedError(new QueuePublishError('pg_failed', 'PG publish failed: rate limited', true, { producerCode: 'rate_limited', retryAfterSeconds: 42 })),
    ).toBe(true);
    expect(isRateLimitedError(new QueuePublishError('pg_failed', 'PG publish failed: ECONNREFUSED', true, { producerCode: 'network_error' }))).toBe(false);
    // And the bare shape a non-producer publisher may throw.
    expect(isRateLimitedError(Object.assign(new Error('rate limited'), { code: 'rate_limited' }))).toBe(true);
    expect(isRateLimitedError(null)).toBe(false);
    expect(isRateLimitedError('rate_limited')).toBe(false);
  });
});
