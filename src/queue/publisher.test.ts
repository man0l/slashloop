// QueuePublisher tests (SLA-16 Phase 2). No database: D1 and PG are
// in-memory fakes. Pins the plan's producer invariants:
// - one stable opId + pre-auth amount passed through verbatim;
// - business validation unchanged (invalid targets reject before transport);
// - PG dedupe returns the same job with no duplicate work;
// - fallback rows reuse the original opId and reconcile one-way with
//   dedupeKey d1:<MediaJob.id>;
// - PG failure without fallback throws retryable (no unowned dual-queue row);
// - the PG body matches the queue-api EnqueueBody contract (required
//   dedupeKey, record payload, credits only with opId, shared d1JobId);
// - SLA-349: a publish refused by the limiter waits out `retry-after` and
//   still lands in PG, and the reconciler keeps its stop-at-the-first-429
//   sweep.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deriveDedupeKey, QueuePublisher, QueuePublishError, type PublisherD1, type PublisherPg } from './publisher.js';
import { isRateLimitedError, publishJobHttp, type FetchImpl } from './producer.js';
import { DEFAULT_RATE_LIMITS, memoryRateLimiter } from './api.js';
import { QUEUE_FALLBACK_STATUS } from './transport.js';

interface FakeD1Row {
  id: string;
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  payloadJson: string;
  opId: string | null;
  preAuthCredits: number | null;
  deadlineAt: Date | null;
  analysisId: string | null;
  queueOwner: 'd1' | 'pg' | 'fallback_d1';
  status: string;
  pgJobId?: string;
}

function makeD1() {
  const rows = new Map<string, FakeD1Row>();
  let n = 0;
  const markCalls: string[] = [];
  const d1: PublisherD1 = {
    createOwnedJob: async (input) => {
      const id = input.id ?? `d1-${++n}`;
      rows.set(id, {
        kind: input.kind,
        workspaceId: input.workspaceId,
        videoId: input.videoId,
        sourceId: input.sourceId,
        payloadJson: input.payloadJson,
        opId: input.opId,
        preAuthCredits: input.preAuthCredits,
        deadlineAt: input.deadlineAt,
        analysisId: input.analysisId,
        queueOwner: input.queueOwner,
        id,
        status: input.status ?? 'queued',
      });
      return { id };
    },
    markD1ProjectionPg: async (d1JobId, pgJobId) => {
      markCalls.push(d1JobId);
      const row = rows.get(d1JobId);
      if (row) {
        row.queueOwner = 'pg';
        row.status = 'queued';
        row.pgJobId = pgJobId;
      }
    },
  };
  return { d1, rows, markCalls };
}

type PgCall = Parameters<PublisherPg['publish']>[0];

function makePg(opts?: { fail?: boolean; message?: string }) {
  const byDedupe = new Map<string, string>();
  let n = 0;
  const calls: PgCall[] = [];
  /** rateLimitWaitBudgetMs each publish was called with (undefined = default). */
  const waitBudgets: (number | undefined)[] = [];
  const pg: PublisherPg = {
    publish: async (input, callOpts) => {
      waitBudgets.push(callOpts?.rateLimitWaitBudgetMs);
      if (opts?.fail) throw new Error(opts.message ?? 'queue_unavailable');
      calls.push(input);
      const existing = byDedupe.get(input.dedupeKey);
      if (existing) return { pgJobId: existing, deduped: true };
      const pgJobId = input.d1JobId ?? `pg-${++n}`;
      byDedupe.set(input.dedupeKey, pgJobId);
      return { pgJobId, deduped: false };
    },
  };
  return { pg, calls, waitBudgets };
}

const baseReq = {
  kind: 'thumb',
  workspaceId: 'ws-1',
  videoId: 'vid-1',
  sourceId: null,
  payload: { thumbnailUrl: 'https://cdn/x.jpg' },
  opId: 'op-stable-1',
  preAuthCredits: null,
};

// console.warn is captured rather than spied so a failing assertion prints the
// actual log line (same approach as src/lib/fallback-reconcile.test.ts).
// Installed for the whole file and put back at the end so nothing leaks.
const warns: string[] = [];
const realWarn = console.warn;
beforeAll(() => { console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); }; });
afterAll(() => { console.warn = realWarn; });

describe('QueuePublisher', () => {
  test('d1 transport creates a d1-owned row with the stable opId', async () => {
    const { d1, rows } = makeD1();
    const pub = new QueuePublisher({ d1, resolveTransport: async () => 'd1' });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('d1');
    expect(ref.pgJobId).toBeNull();
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('d1');
    expect(row.status).toBe('queued');
    expect(row.opId).toBe('op-stable-1');
  });

  test('invalid targets reject before transport selection', async () => {
    const { d1 } = makeD1();
    const pub = new QueuePublisher({ d1, resolveTransport: async () => 'd1' });
    // discover forbids videoId/sourceId.
    await expect(
      pub.publish({ ...baseReq, kind: 'discover', videoId: 'vid-1' }),
    ).rejects.toBeInstanceOf(QueuePublishError);
  });

  test('pg publish projects to D1 with queueOwner pg and keeps opId', async () => {
    const { d1, rows, markCalls } = makeD1();
    const { pg, calls } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('pg');
    expect(ref.pgJobId).not.toBeNull();
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('pg');
    expect(row.status).toBe('queued');
    expect(row.opId).toBe('op-stable-1');
    // The INSERT is the projection. No second UPDATE of the same columns.
    expect(markCalls).toEqual([]);
    // API body contract: shared id, record payload, credits carry the opId.
    expect(calls[0].d1JobId).toBe(ref.d1JobId);
    expect(calls[0].payload).toEqual({ thumbnailUrl: 'https://cdn/x.jpg' });
    expect(calls[0].credits).toEqual({ opId: 'op-stable-1', preAuthCredits: 0 });
  });

  test('pg publish sends credits only when opId is set', async () => {
    const { d1 } = makeD1();
    const { pg, calls } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    await pub.publish({ ...baseReq, opId: 'op-9', preAuthCredits: 5 });
    expect(calls[0].credits).toEqual({ opId: 'op-9', preAuthCredits: 5 });
    // Free kinds (thumb/fetch) carry no opId — credits omitted entirely.
    await pub.publish({ ...baseReq, opId: null, preAuthCredits: null, dedupeKey: 'thumb:video:other' });
    expect(calls[1].credits).toBeNull();
  });

  test('same-key pg replay dedupes with no duplicate work', async () => {
    const { d1, rows } = makeD1();
    const { pg } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const first = await pub.publish({ ...baseReq, dedupeKey: 'thumb:video:vid-1' });
    const second = await pub.publish({ ...baseReq, dedupeKey: 'thumb:video:vid-1' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.pgJobId).toBe(first.pgJobId);
    expect(second.d1JobId).toBe(first.d1JobId);
    expect(rows.size).toBe(1);
  });

  test('pg failure without fallback throws retryable, writes nothing', async () => {
    const { d1, rows } = makeD1();
    const { pg } = makePg({ fail: true });
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const err = await pub.publish({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(QueuePublishError);
    expect((err as QueuePublishError).retryable).toBe(true);
    expect(rows.size).toBe(0);
  });

  test('pg failure with fallback writes a non-claimable row with the same opId', async () => {
    const { d1, rows } = makeD1();
    const { pg } = makePg({ fail: true });
    const pub = new QueuePublisher({
      d1,
      pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('fallback_d1');
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('fallback_d1');
    expect(row.status).toBe(QUEUE_FALLBACK_STATUS);
    expect(row.opId).toBe('op-stable-1');
  });

  // SLA-141: the park used to be silent, and a parked row is visible to no
  // claimer — so "scraper claimed zero while the sweep kept queueing" was the
  // entire operator-visible story, with no line anywhere naming the cause.
  test('parking a fallback row says so, names the kind and the cause', async () => {
    warns.length = 0;
    const { d1 } = makeD1();
    const { pg } = makePg({ fail: true, message: 'queue-api unreachable' });
    const pub = new QueuePublisher({
      d1,
      pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await pub.publish({ ...baseReq });
    expect(warns).toHaveLength(1);
    const line = warns[0];
    expect(line).toContain('kind=thumb');
    expect(line).toContain(`d1=${ref.d1JobId}`);
    expect(line).toContain(`fallback_d1/${QUEUE_FALLBACK_STATUS}`);
    expect(line).toContain('queue-api unreachable');
    expect(line).toContain('reconcileFallbackJobs');
    // The secret never reaches the log line: only the transport error text.
    expect(line).not.toContain('secret');
  });

  test('a successful publish logs no park', async () => {
    warns.length = 0;
    const { d1 } = makeD1();
    const { pg } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    await pub.publish({ ...baseReq });
    expect(warns).toEqual([]);
  });

  test('reconciliation is one-way with dedupeKey d1:<id> and the original opId', async () => {
    const { d1, rows, markCalls } = makeD1();
    const { pg } = makePg({ fail: true });
    const pub = new QueuePublisher({
      d1,
      pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await pub.publish({ ...baseReq });
    // PG recovers; reconcile the fallback row.
    const { pg: pg2, calls: calls2 } = makePg();
    const pub2 = new QueuePublisher({ d1, pg: pg2, resolveTransport: async () => 'pg' });
    const row = rows.get(ref.d1JobId)!;
    const asRow = {
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspaceId,
      videoId: row.videoId,
      sourceId: row.sourceId,
      payloadJson: row.payloadJson,
      opId: row.opId,
      preAuthCredits: row.preAuthCredits,
      deadlineAt: row.deadlineAt,
    };
    const done = await pub2.reconcileFallbackRow(asRow);
    expect(done.transport).toBe('pg');
    expect(markCalls).toEqual([row.id]);
    expect(calls2[0].dedupeKey).toBe(`d1:${row.id}`);
    expect(calls2[0].credits).toEqual({ opId: 'op-stable-1', preAuthCredits: 0 });
    expect(calls2[0].d1JobId).toBe(row.id);
    expect(row.queueOwner).toBe('pg');
    expect(row.status).toBe('queued');
    // Reconciling again dedupes onto the same PG job — never a second row.
    const again = await pub2.reconcileFallbackRow(asRow);
    expect(again.pgJobId).toBe(done.pgJobId);
    expect(again.deduped).toBe(true);
  });

  test('discover dedupe binds to opId, never the shared empty key', async () => {
    expect(
      deriveDedupeKey({ kind: 'discover', videoId: null, sourceId: null, opId: 'op-d1' }),
    ).toBe('discover:op:op-d1');
    const minted = deriveDedupeKey({ kind: 'discover', videoId: null, sourceId: null, opId: null });
    expect(minted.startsWith('discover:run:')).toBe(true);
    expect(minted.length).toBeGreaterThan('discover:run:'.length);
  });
});

// SLA-349. The 429 path is exercised against queue-api's real limiter
// (memoryRateLimiter + DEFAULT_RATE_LIMITS) on a virtual clock: the fake sleep
// advances that clock instead of blocking, so the retry-after the limiter
// computes is the same one a real caller would be handed, and the burst
// resolves in milliseconds of wall clock.
describe('QueuePublisher under the queue-api limiter', () => {
  const SECRET = 'publisher-burst-secret';
  const KEY_ID = 'qk-publisher-01';

  /** queue-api's enqueue limit gate (src/queue/api.ts), on a virtual clock. */
  function fakeQueueApi(clock: { now: number }) {
    const limiter = memoryRateLimiter(() => clock.now);
    const byDedupe = new Map<string, string>();
    const requests: { dedupeKey: string; status: number }[] = [];
    let accepted = 0;
    const fetchImpl: FetchImpl = async (_url, init) => {
      const parsed = JSON.parse(new TextDecoder().decode(init.body)) as {
        kind: string;
        workspaceId: string;
        dedupeKey: string;
      };
      const retryAfter =
        limiter.take(`ws:${parsed.workspaceId}`, DEFAULT_RATE_LIMITS.perWorkspacePerMinute)
        ?? limiter.take(
          `kind:${parsed.kind}:${parsed.workspaceId}`,
          DEFAULT_RATE_LIMITS.perKindWorkspacePerMinute,
        );
      if (retryAfter != null) {
        requests.push({ dedupeKey: parsed.dedupeKey, status: 429 });
        return {
          status: 429,
          headers: {
            get: (n: string) => (n.toLowerCase() === 'retry-after' ? String(retryAfter) : null),
          },
          text: async () => JSON.stringify({ error: { code: 'rate_limited', message: 'per-kind publish limit exceeded' } }),
        };
      }
      const existing = byDedupe.get(parsed.dedupeKey);
      const jobId = existing ?? `pg-job-${++accepted}`;
      byDedupe.set(parsed.dedupeKey, jobId);
      requests.push({ dedupeKey: parsed.dedupeKey, status: 202 });
      return {
        status: 202,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jobId, deduped: existing != null }),
      };
    };
    return { fetchImpl, requests };
  }

  test('a burst above the per-kind ceiling lands in PG inside one retry-after window, nothing parked', async () => {
    const clock = { now: 1_800_000_000_000 };
    const start = clock.now;
    const { d1, rows } = makeD1();
    const { fetchImpl, requests } = fakeQueueApi(clock);
    const slept: number[] = [];
    const pg: PublisherPg = {
      publish: (input, opts) =>
        publishJobHttp(
          { baseUrl: 'https://queue.test', keyId: KEY_ID, secret: SECRET, timeoutMs: 5000 },
          {
            kind: input.kind,
            workspaceId: input.workspaceId,
            videoId: input.videoId,
            sourceId: input.sourceId,
            dedupeKey: input.dedupeKey,
            deadlineAt: input.deadlineAt,
            payload: input.payload,
            credits: input.credits,
            d1JobId: input.d1JobId,
          },
          {
            fetchImpl,
            nowSeconds: () => Math.floor(clock.now / 1000),
            nonceHex: () => `nonce-${requests.length + 1}`,
            sleep: async (ms) => { slept.push(ms); clock.now += ms; },
            ...(opts?.rateLimitWaitBudgetMs != null
              ? { rateLimitWaitBudgetMs: opts.rateLimitWaitBudgetMs }
              : {}),
          },
        ),
    };
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg', fallbackEnabled: true });

    // The SLA-349 shape: a serial fan-out larger than the per-kind+workspace
    // ceiling (10/minute) — what the measured 34-source rescore burst was.
    const total = DEFAULT_RATE_LIMITS.perKindWorkspacePerMinute + 4;
    const refs = [];
    for (let i = 1; i <= total; i++) {
      refs.push(await pub.publish({ ...baseReq, videoId: `vid-${i}`, dedupeKey: `thumb:video:vid-${i}` }));
    }

    // Every job is a real PG publish with a claimable projection. Before
    // SLA-349 the tail was parked as fallback_d1 / queued_remote — invisible
    // to every claimer until a reconciler sweep, which is the 8m08s staircase
    // measured on 34 rescores inside 9.5s.
    expect(refs.map((r) => r.transport)).toEqual(Array(total).fill('pg'));
    expect(refs.every((r) => r.pgJobId != null)).toBe(true);
    expect(rows.size).toBe(total);
    expect([...rows.values()].every((r) => r.queueOwner === 'pg' && r.status === 'queued')).toBe(true);
    expect([...rows.values()].filter((r) => r.queueOwner === 'fallback_d1')).toEqual([]);

    // Exactly one publish was refused, and the wait it asked for IS the whole
    // delay: the server said 60s, the producer waited 60s, and that one wait
    // reopened the window for the remaining three.
    expect(requests.filter((r) => r.status === 429)).toHaveLength(1);
    expect(slept).toEqual([60_000]);
    expect(clock.now - start).toBe(60_000);
  });

  test('the reconciler asks for no rate-limit wait, so its sweep still stops at the first 429', async () => {
    const { d1, rows } = makeD1();
    const failing = makePg({ fail: true });
    const parked = new QueuePublisher({
      d1,
      pg: failing.pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await parked.publish({ ...baseReq });
    // A fresh publish takes the transport default (wait out `retry-after`).
    expect(failing.waitBudgets).toEqual([undefined]);

    const { pg: healthy, waitBudgets } = makePg();
    const reconciler = new QueuePublisher({ d1, pg: healthy, resolveTransport: async () => 'pg' });
    await reconciler.reconcileFallbackRow({
      id: ref.d1JobId,
      kind: 'thumb',
      workspaceId: 'ws-1',
      videoId: 'vid-1',
      sourceId: null,
      payloadJson: '{}',
      opId: null,
      preAuthCredits: null,
      deadlineAt: null,
    });
    expect(waitBudgets).toEqual([0]);
    expect(rows.get(ref.d1JobId)?.queueOwner).toBe('pg');
  });

  test('a 429 that outlasts the wait budget stays a rate limit through the rethrow', async () => {
    const { d1, rows } = makeD1();
    const pg: PublisherPg = {
      publish: async () => {
        throw new QueuePublishError('pg_failed', 'PG publish failed for kind "thumb": slow down', true, {
          producerCode: 'rate_limited',
          retryAfterSeconds: 42,
        });
      },
    };
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg', fallbackEnabled: false });
    const err = await pub.publish({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(QueuePublishError);
    // Before SLA-349 every publish failure came back as a bare pg_failed, so
    // a caller could only string-match the message to learn it was a limit.
    expect((err as QueuePublishError).producerCode).toBe('rate_limited');
    expect((err as QueuePublishError).retryAfterSeconds).toBe(42);
    expect(isRateLimitedError(err)).toBe(true);
    expect(rows.size).toBe(0);
  });
});
