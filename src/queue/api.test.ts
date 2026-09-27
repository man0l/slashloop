// queue-api handler tests: auth ordering, replay, raw-body, validation,
// cancellation, rate/body limits. Uses an in-memory stub shaped like PgQueue
// (no database, no network).
import { describe, expect, test } from 'bun:test';
import { mapKeyStore } from './auth.js';
import { signRequest } from './auth.js';
import {
  DEFAULT_RATE_LIMITS,
  handleQueueRequest,
  memoryRateLimiter,
  type QueueApiDeps,
  type QueueHttpRequest,
} from './api.js';
import type { PgQueue } from './pg.js';
import type { PgQueueJobRow } from './contract.js';

const SECRET = 'api-test-secret';
const NOW = 1_800_000_000;

interface StubState {
  jobs: Map<string, PgQueueJobRow>;
  nonces: Set<string>;
  cancels: string[];
}

function stubQueue(state: StubState): PgQueue {
  let seq = 0;
  const api = {
    async consumeNonce(keyId: string, nonce: string, _expires: Date) {
      const k = `${keyId}:${nonce}`;
      if (state.nonces.has(k)) return false;
      state.nonces.add(k);
      return true;
    },
    async enqueue(input: {
      kind: string;
      workspaceId: string;
      videoId: string | null;
      sourceId: string | null;
      dedupeKey: string | null;
      opId?: string | null;
      preAuthCredits?: number | null;
    }) {
      for (const row of state.jobs.values()) {
        if (input.dedupeKey && row.dedupe_key === input.dedupeKey) return { row, deduped: true };
      }
      const now = new Date().toISOString();
      const row: PgQueueJobRow = {
        job_id: `22222222-2222-4222-8222-2222222222${String(seq++).padStart(2, '0')}`,
        dedupe_key: input.dedupeKey,
        kind: input.kind,
        state: 'queued',
        attempts: 0,
        max_attempts: 3,
        claimed_by: null,
        lease_expires_at: null,
        workspace_id: input.workspaceId,
        video_id: input.videoId,
        source_id: input.sourceId,
        payload: {},
        result: null,
        op_id: input.opId ?? null,
        pre_auth_credits: input.preAuthCredits ?? null,
        deadline_at: null,
        analysis_id: null,
        available_at: now,
        started_at: null,
        finished_at: null,
        last_error: null,
        cancel_requested_at: null,
        d1_synced_at: null,
        d1_job_id: null,
        created_at: now,
        updated_at: now,
      };
      state.jobs.set(row.job_id, row);
      return { row, deduped: false };
    },
    async getJob(jobId: string) {
      return state.jobs.get(jobId) ?? null;
    },
    async requestCancel(jobId: string) {
      const row = state.jobs.get(jobId);
      if (!row) return { cancelled: false as const, reason: 'not_found' as const };
      if (row.state === 'running') {
        return { cancelled: false as const, reason: 'job_not_cancellable' as const };
      }
      if (row.state !== 'queued') {
        return { cancelled: false as const, reason: 'already_terminal' as const };
      }
      row.state = 'cancelled';
      row.finished_at = new Date().toISOString();
      state.cancels.push(jobId);
      return { cancelled: true as const, row };
    },
  };
  return api as unknown as PgQueue;
}

function deps(state: StubState, opts?: { limiter?: ReturnType<typeof memoryRateLimiter> }): QueueApiDeps {
  return {
    queue: stubQueue(state),
    keys: mapKeyStore([{ keyId: 'k1', secret: SECRET, state: 'active' }]),
    limiter: opts?.limiter ?? memoryRateLimiter(),
    limits: DEFAULT_RATE_LIMITS,
    ping: async () => true,
    nowSeconds: () => NOW,
  };
}

function signedRequest(
  method: string,
  path: string,
  body: string,
  opts?: { nonce?: string; timestamp?: string; secret?: string; query?: string },
): QueueHttpRequest {
  const timestamp = opts?.timestamp ?? String(NOW);
  const nonce = opts?.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  return {
    method,
    path,
    query: opts?.query ?? '',
    headers: {
      'X-SLQ-Key-Id': 'k1',
      'X-SLQ-Timestamp': timestamp,
      'X-SLQ-Nonce': nonce,
      'X-SLQ-Signature': signRequest(opts?.secret ?? SECRET, method, path, timestamp, nonce, body),
    },
    rawBody: new TextEncoder().encode(body),
  };
}

const ENQUEUE = JSON.stringify({
  kind: 'analyze',
  workspaceId: 'ws1',
  videoId: 'v1',
  sourceId: null,
  dedupeKey: 'analyze:video:v1',
  payload: {},
  credits: { opId: 'op-1', preAuthCredits: 5 },
});

describe('health checks', () => {
  test('healthz/readyz need no auth', async () => {
    const d = deps({ jobs: new Map(), nonces: new Set(), cancels: [] });
    const h = await handleQueueRequest({ method: 'GET', path: '/healthz', query: '', headers: {}, rawBody: new Uint8Array() }, d);
    expect(h.status).toBe(200);
    const r = await handleQueueRequest({ method: 'GET', path: '/readyz', query: '', headers: {}, rawBody: new Uint8Array() }, d);
    expect(r.status).toBe(200);
  });
});

describe('enqueue', () => {
  test('happy path returns 202 with jobId; replay dedupes to the same job', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const r1 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'n1' }), d);
    expect(r1.status).toBe(202);
    const b1 = JSON.parse(r1.body);
    expect(b1.deduped).toBe(false);
    // Same dedupe key, fresh nonce -> same job, deduped=true.
    const r2 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'n2' }), d);
    expect(r2.status).toBe(202);
    const b2 = JSON.parse(r2.body);
    expect(b2.deduped).toBe(true);
    expect(b2.jobId).toBe(b1.jobId);
    expect(state.jobs.size).toBe(1);
  });

  test('replayed nonce -> 409 replay_detected, no second enqueue', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const r1 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'dup' }), d);
    expect(r1.status).toBe(202);
    const other = ENQUEUE.replace('analyze:video:v1', 'analyze:video:v2').replace('"v1"', '"v2"');
    const r2 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', other, { nonce: 'dup' }), d);
    expect(r2.status).toBe(409);
    expect(JSON.parse(r2.body).error.code).toBe('replay_detected');
    expect(state.jobs.size).toBe(1);
  });

  test('unsigned request -> 401 before validation', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const bad: QueueHttpRequest = {
      method: 'POST',
      path: '/v1/jobs',
      query: '',
      headers: {},
      rawBody: new TextEncoder().encode('not-json{{{'),
    };
    const res = await handleQueueRequest(bad, d);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('unauthenticated');
  });

  test('signed but invalid body -> 422 (auth passed, validation failed)', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const res = await handleQueueRequest(signedRequest('POST', '/v1/jobs', '{"kind":"nope"}', { nonce: 'v1' }), d);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('invalid_job');
  });

  test('target matrix: refresh without source -> 422 invalid_target', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const body = JSON.stringify({
      kind: 'refresh',
      workspaceId: 'ws1',
      videoId: 'v1',
      sourceId: null,
      dedupeKey: 'refresh:source:x',
    });
    const res = await handleQueueRequest(signedRequest('POST', '/v1/jobs', body, { nonce: 't1' }), d);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('invalid_target');
  });

  test('oversized body -> 413; query string on POST -> 401', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const big = signedRequest('POST', '/v1/jobs', 'x'.repeat(64 * 1024 + 1), { nonce: 'big' });
    const r1 = await handleQueueRequest(big, d);
    expect(r1.status).toBe(413);
    const q = signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'q1', query: 'x=1' });
    const r2 = await handleQueueRequest(q, d);
    expect(r2.status).toBe(401);
  });

  test('trailing slash + unknown path reject before verification', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const r1 = await handleQueueRequest(
      { method: 'POST', path: '/v1/jobs/', query: '', headers: {}, rawBody: new Uint8Array() },
      d,
    );
    expect(r1.status).toBe(404);
    const r2 = await handleQueueRequest(
      { method: 'GET', path: '/v1/nope', query: '', headers: {}, rawBody: new Uint8Array() },
      d,
    );
    expect(r2.status).toBe(404);
  });

  test('per-key rate limit -> 429 with Retry-After', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    let now = Date.now();
    const limiter = memoryRateLimiter(() => now);
    const d = deps(state, { limiter });
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const body = ENQUEUE.replace('analyze:video:v1', `k:v${i}`).replace('"videoId":"v1"', `"videoId":"v${i}"`);
      const res = await handleQueueRequest(signedRequest('POST', '/v1/jobs', body, { nonce: `rl-${i}` }), d);
      if (res.status === 429) {
        limited++;
        expect(res.headers['retry-after']).toBeDefined();
        expect(JSON.parse(res.body).error.code).toBe('rate_limited');
        expect(JSON.parse(res.body).error.retryable).toBe(true);
      }
      now += 100;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('status + cancel', () => {
  async function enqueued(state: StubState): Promise<string> {
    const d = deps(state);
    const r = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: `s-${state.jobs.size}` }), d);
    return (JSON.parse(r.body) as { jobId: string }).jobId;
  }

  test('GET returns queue-safe status', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const jobId = await enqueued(state);
    const d = deps(state);
    const res = await handleQueueRequest(signedRequest('GET', `/v1/jobs/${jobId}`, '', { nonce: 'g1' }), d);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jobId).toBe(jobId);
    expect(body.state).toBe('queued');
    expect(body.payload).toBeUndefined();
  });

  test('cancel queued -> cancelled; second cancel idempotent 200', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const jobId = await enqueued(state);
    const d = deps(state);
    const r1 = await handleQueueRequest(signedRequest('POST', `/v1/jobs/${jobId}/cancel`, '', { nonce: 'c1' }), d);
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body).state).toBe('cancelled');
    const r2 = await handleQueueRequest(signedRequest('POST', `/v1/jobs/${jobId}/cancel`, '', { nonce: 'c2' }), d);
    expect(r2.status).toBe(200);
    expect(JSON.parse(r2.body).state).toBe('cancelled');
    expect(state.cancels.length).toBe(1);
  });

  test('cancel running -> 409 job_not_cancellable', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const jobId = await enqueued(state);
    state.jobs.get(jobId)!.state = 'running';
    const d = deps(state);
    const res = await handleQueueRequest(signedRequest('POST', `/v1/jobs/${jobId}/cancel`, '', { nonce: 'c3' }), d);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('job_not_cancellable');
  });

  test('unknown job -> 404', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const id = '33333333-3333-4333-8333-333333333333';
    const res = await handleQueueRequest(signedRequest('GET', `/v1/jobs/${id}`, '', { nonce: 'g9' }), d);
    expect(res.status).toBe(404);
  });
});
