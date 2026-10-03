// queue-api handler tests: auth ordering, replay, raw-body, validation,
// cancellation, rate/body limits. Uses an in-memory stub shaped like PgQueue
// (no database, no network).
import { describe, expect, test } from 'bun:test';
import { mapKeyStore } from './auth.js';
import { signRequest, type ProducerKey } from './auth.js';
import {
  DEFAULT_RATE_LIMITS,
  handleQueueRequest,
  memoryRateLimiter,
  type QueueApiDeps,
  type QueueHttpRequest,
  type RateLimiter,
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

function deps(
  state: StubState,
  opts?: { limiter?: RateLimiter; keys?: ProducerKey[] },
): QueueApiDeps {
  return {
    queue: stubQueue(state),
    keys: mapKeyStore(opts?.keys ?? [{ keyId: 'k1', secret: SECRET, state: 'active' }]),
    limiter: opts?.limiter ?? memoryRateLimiter(),
    limits: DEFAULT_RATE_LIMITS,
    ping: async () => true,
    nowSeconds: () => NOW,
  };
}

/** Rate limiter that remembers every bucket key it was asked about. */
function recordingLimiter(inner: RateLimiter = memoryRateLimiter()): RateLimiter & { taken: string[] } {
  const taken: string[] = [];
  return {
    taken,
    take(key, limit, windowSeconds) {
      taken.push(key);
      return inner.take(key, limit, windowSeconds);
    },
  };
}

function signedRequest(
  method: string,
  path: string,
  body: string,
  opts?: { nonce?: string; timestamp?: string; secret?: string; query?: string; keyId?: string },
): QueueHttpRequest {
  const timestamp = opts?.timestamp ?? String(NOW);
  const nonce = opts?.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  return {
    method,
    path,
    query: opts?.query ?? '',
    headers: {
      'X-SLQ-Key-Id': opts?.keyId ?? 'k1',
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

function enqueueFor(workspaceId: string, videoId: string): string {
  return JSON.stringify({
    kind: 'analyze',
    workspaceId,
    videoId,
    sourceId: null,
    dedupeKey: `analyze:video:${videoId}`,
    payload: {},
  });
}

// A scoped producer key exactly as QUEUE_API_KEYS_JSON can express it
// (server.ts loadKeys): the optional `workspaceIds` is the ONLY thing that
// narrows a key, and prod env keys (QUEUE_API_KEY_ACTIVE_*) have none.
const SCOPED_KEYS_JSON = `[{"keyId":"k-scoped","secret":"${SECRET}","state":"active","workspaceIds":["ws1"]}]`;
const SCOPED_KEYS = JSON.parse(SCOPED_KEYS_JSON) as ProducerKey[];
/** A second scope, so "ws1 only" vs "ws9 only" can be told apart. */
const OTHER_KEYS: ProducerKey[] = [{ keyId: 'k-other', secret: SECRET, state: 'active', workspaceIds: ['ws9'] }];

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

  test('a dedupe reports the real state of the row it resolved to (SLA-329)', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state);
    const r1 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'st1' }), d);
    expect(JSON.parse(r1.body).state).toBe('queued');
    // The row the second publish resolves to is finished. Reporting 'queued'
    // here is what let a permanent dedupe read as fresh work at every call
    // site, so the 202 must carry the row's own state.
    for (const row of state.jobs.values()) row.state = 'done';
    const r2 = await handleQueueRequest(signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'st2' }), d);
    const b2 = JSON.parse(r2.body);
    expect(b2.deduped).toBe(true);
    expect(b2.state).toBe('done');
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

  // SLA-354: a refresh sweep bursts one fetch per new photo post and the
  // fetch_videos tool accepts up to 50 in one call, so `fetch` carries its
  // own higher per-kind budget while every other kind keeps the generic one.
  const burstBody = (kind: string, i: number) =>
    ENQUEUE
      .replace('"kind":"analyze"', `"kind":"${kind}"`)
      .replace('analyze:video:v1', `${kind}:video:vk-${i}`)
      .replace('"videoId":"v1"', `"videoId":"vk-${i}"`);

  test('fetch gets the raised 50/minute per-kind budget', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state, { limiter: memoryRateLimiter() });
    // All 50 fetch publishes fit: the fetch override is 50 and the workspace
    // budget (60) still has headroom, so the KIND budget is the binding one.
    for (let i = 0; i < 50; i++) {
      const res = await handleQueueRequest(
        signedRequest('POST', '/v1/jobs', burstBody('fetch', i), { nonce: `fk-${i}` }),
        d,
      );
      expect(res.status).toBe(202);
    }
    const overFetch = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', burstBody('fetch', 51), { nonce: 'fk-51' }),
      d,
    );
    expect(overFetch.status).toBe(429);
    expect(JSON.parse(overFetch.body).error.message).toBe('per-kind publish limit exceeded');
    expect(overFetch.headers['retry-after']).toBeDefined();
  });

  test('non-overridden kinds keep the generic 10/minute budget', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state, { limiter: memoryRateLimiter() });
    // 10 analyze fit; the 11th is refused by the KIND budget even though the
    // workspace budget has room.
    for (let i = 0; i < 10; i++) {
      const res = await handleQueueRequest(
        signedRequest('POST', '/v1/jobs', burstBody('analyze', i), { nonce: `an-${i}` }),
        d,
      );
      expect(res.status).toBe(202);
    }
    const overAnalyze = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', burstBody('analyze', 11), { nonce: 'an-11' }),
      d,
    );
    expect(overAnalyze.status).toBe(429);
    expect(JSON.parse(overAnalyze.body).error.message).toBe('per-kind publish limit exceeded');
  });

  test('the per-workspace budget still bounds a mixed-kind burst', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const d = deps(state, { limiter: memoryRateLimiter() });
    const post = async (kind: string, nonce: string, i = 0) =>
      handleQueueRequest(signedRequest('POST', '/v1/jobs', burstBody(kind, i), { nonce }), d);

    // 50 fetch + 10 analyze = exactly the 60/minute workspace budget.
    for (let i = 0; i < 50; i++) expect((await post('fetch', `wf-${i}`, i)).status).toBe(202);
    for (let i = 0; i < 10; i++) expect((await post('analyze', `wa-${i}`, i)).status).toBe(202);

    // The 61st publish of ANY kind is a per-workspace refusal: the shared
    // workspace cap still bounds bursts the kind caps let through.
    const overWs = await post('fetch', 'wf-51', 51);
    expect(overWs.status).toBe(429);
    expect(JSON.parse(overWs.body).error.message).toBe('per-workspace publish limit exceeded');
  });
});

describe('workspace scope (SLA-351)', () => {
  const scopedDeps = (state: StubState, limiter?: RateLimiter) =>
    deps(state, { keys: SCOPED_KEYS, limiter });

  test('a scoped key still publishes into its own workspace', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const r = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'ok1', keyId: 'k-scoped' }),
      scopedDeps(state),
    );
    expect(r.status).toBe(202);
    expect(state.jobs.size).toBe(1);
  });

  test('a scoped key cannot publish into another workspace', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const r = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', enqueueFor('ws2', 'v2'), { nonce: 'no1', keyId: 'k-scoped' }),
      scopedDeps(state),
    );
    expect(r.status).toBe(403);
    const body = JSON.parse(r.body);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.retryable).toBe(false);
    // Nothing enqueued, and the nonce is NOT burned so the producer can retry
    // the same publish under a workspace its key actually owns.
    expect(state.jobs.size).toBe(0);
    expect(state.nonces.has('k-scoped:no1')).toBe(false);
  });

  test('a rejected cross-workspace publish never spends the target workspace budget', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const limiter = recordingLimiter();
    const d = scopedDeps(state, limiter);
    for (let i = 0; i < 5; i++) {
      const r = await handleQueueRequest(
        signedRequest('POST', '/v1/jobs', enqueueFor('ws2', `x${i}`), { nonce: `drain-${i}`, keyId: 'k-scoped' }),
        d,
      );
      expect(r.status).toBe(403);
    }
    // The buckets are keyed on the client-supplied workspaceId, so this is the
    // cross-tenant quota drain the scope check has to stop: only the attacker's
    // own per-key budget may move.
    expect(limiter.taken).not.toContain('ws:ws2');
    expect(limiter.taken.some((k) => k.startsWith('kind:'))).toBe(false);
    // ws2 still has its full budget: 10 kind+workspace publishes/minute.
    for (let i = 0; i < DEFAULT_RATE_LIMITS.perKindWorkspacePerMinute; i++) {
      const ok = await handleQueueRequest(
        signedRequest('POST', '/v1/jobs', enqueueFor('ws2', `ok-${i}`), { nonce: `ws2-${i}` }),
        deps(state),
      );
      expect(ok.status).toBe(202);
    }
  });

  test('an unscoped key (no workspaceIds) still publishes anywhere', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const r = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', enqueueFor('ws2', 'v2'), { nonce: 'star1' }),
      deps(state),
    );
    expect(r.status).toBe(202);
  });

  test('GET and cancel enforce the same scope as enqueue', async () => {
    const state: StubState = { jobs: new Map(), nonces: new Set(), cancels: [] };
    const enq = await handleQueueRequest(
      signedRequest('POST', '/v1/jobs', ENQUEUE, { nonce: 'seed1' }),
      deps(state),
    );
    const jobId = (JSON.parse(enq.body) as { jobId: string }).jobId;
    const d = scopedDeps(state);
    const get = await handleQueueRequest(
      signedRequest('GET', `/v1/jobs/${jobId}`, '', { nonce: 'sg1', keyId: 'k-scoped' }),
      d,
    );
    expect(get.status).toBe(200); // ws1 is in scope
    const other = await handleQueueRequest(
      signedRequest('GET', `/v1/jobs/${jobId}`, '', { nonce: 'sg2', keyId: 'k-other' }),
      deps(state, { keys: OTHER_KEYS }),
    );
    expect(other.status).toBe(403);
    const cancel = await handleQueueRequest(
      signedRequest('POST', `/v1/jobs/${jobId}/cancel`, '', { nonce: 'sc1', keyId: 'k-other' }),
      deps(state, { keys: OTHER_KEYS }),
    );
    expect(cancel.status).toBe(403);
    expect(state.cancels).toEqual([]);
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
