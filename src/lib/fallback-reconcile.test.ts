// Sweep that unparks fallback_d1 queued_remote rows via one-way PG republish.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Snapshot the REAL ../store.js by value before any mock.module runs, and put
// it back in afterAll. bun's mock.module rewrites the shared module registry
// entry for the whole `bun test` PROCESS and mock.restore() does not undo it,
// so this stub used to outlive the file: rawBatch stayed `async () => [[]]`
// for every later test file, and src/cf/internal.test.ts then read 200 from a
// batch that never reached D1. Ordering between files is not stable across
// machines, which is why this only ever failed in CI.
// See also src/lib/queue-owner.test.ts, which stubs the same module.
import * as realStore from '../store.js';
const REAL_STORE = { ...realStore };

afterAll(() => {
  mock.module('../store.js', () => ({ ...REAL_STORE }));
});

const seen: {
  findWhere: unknown;
  countWhere: unknown;
  countCalls: number;
  reconcile: Array<Record<string, unknown>>;
  /** Ids of rows the mocked findMany should return, oldest first. */
  rows: string[];
  /** console.warn lines emitted by the code under test. */
  warns: string[];
} = {
  findWhere: null,
  countWhere: null,
  countCalls: 0,
  reconcile: [],
  rows: [],
  warns: [],
};

/** Sweep-start instant of the oldest mocked row; later rows step +1min. */
const PARKED_CREATED_AT = new Date('2026-10-02T18:16:00.000Z');

function parkedRow(id: string, index = 0): Record<string, unknown> {
  return {
    id,
    kind: 'thumb',
    workspaceId: 'ws-1',
    videoId: `v-${id}`,
    sourceId: null,
    payloadJson: '{}',
    opId: `op-${id}`,
    preAuthCredits: 0,
    deadlineAt: null,
    analysisId: null,
    // The real query orders by createdAt asc, so index 0 is the global
    // oldest — the row the sweep must report as the reconcile lag.
    createdAt: new Date(PARKED_CREATED_AT.getTime() + index * 60_000),
  };
}

mock.module('../db.js', () => ({
  db: {
    mediaJob: {
      findMany: async ({ where }: { where: unknown }) => {
        seen.findWhere = where;
        return seen.rows.map((id, index) => parkedRow(id, index));
      },
      count: async ({ where }: { where: unknown }) => {
        seen.countWhere = where;
        seen.countCalls++;
        return seen.rows.length;
      },
    },
  },
  dbDialect: () => 'sqlite',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

mock.module('../store.js', () => ({
  chunked: async () => {},
  coerceRowDates: (row: Record<string, unknown>) => row,
  dbDialect: () => 'sqlite',
  rawBatch: async () => [[]],
}));

import { reconcileFallbackJobs, resetFallbackThrottleLogForTests } from './jobs.js';
import { QUEUE_FALLBACK_STATUS } from '../queue/transport.js';
import { fallbackDedupeKey } from '../queue/contract.js';
import { ProducerHttpError } from '../queue/producer.js';
import { QueuePublishError } from '../queue/publisher.js';

/** Accepts everything; records the publishes it was asked to make. */
function okPublisher() {
  return {
    reconcileFallbackRow: async (row: { id: string; opId: string | null }) => {
      seen.reconcile.push({ id: row.id, opId: row.opId, dedupe: fallbackDedupeKey(row.id) });
      return { d1JobId: row.id, pgJobId: row.id, transport: 'pg' as const, deduped: false };
    },
  };
}

const rateLimited = () =>
  new ProducerHttpError('rate_limited', 'per-workspace publish limit exceeded', {
    status: 429,
    retryable: true,
    retryAfterSeconds: 42,
  });

beforeEach(() => {
  seen.reconcile.length = 0;
  seen.rows = [];
  seen.warns.length = 0;
  seen.countWhere = null;
  seen.countCalls = 0;
  // The throttle window is process-wide by design, so each case starts from a
  // clean slate and can assert on the FIRST occurrence.
  resetFallbackThrottleLogForTests();
});

// console.warn is captured rather than spied so a failing assertion prints
// the actual log line. Installed for the whole file (not per test — an
// afterEach restore would un-capture it again after the first case) and put
// back at the end so nothing leaks into the rest of the suite.
const realWarn = console.warn;
beforeAll(() => { console.warn = (...args: unknown[]) => { seen.warns.push(args.map(String).join(' ')); }; });
afterAll(() => { console.warn = realWarn; });

/** Every publish refused, i.e. the limiter is spent for the whole window. */
const throttledPublisher = () => ({ reconcileFallbackRow: async () => { throw rateLimited(); } });

describe('reconcileFallbackJobs', () => {
  test('selects fallback_d1 queued_remote and republishes with d1:<id> + original opId', async () => {
    seen.rows = ['fb-1'];
    const out = await reconcileFallbackJobs({ take: 50, publisher: okPublisher() as never });
    expect(seen.findWhere).toEqual({ queueOwner: 'fallback_d1', status: QUEUE_FALLBACK_STATUS });
    expect(out).toEqual({
      reconciled: 1,
      failed: 0,
      more: false,
      backlog: 1,
      oldestAt: PARKED_CREATED_AT,
    });
    expect(seen.reconcile).toEqual([{ id: 'fb-1', opId: 'op-fb-1', dedupe: 'd1:fb-1' }]);
  });

  // SLA-317: live on 2026-10-01 the reconciler logged one warning per parked
  // row (`reconciled=0 failed=25`) because queue-api refused the 11th publish
  // in its per-kind+workspace window and the sweep kept going.
  test('stops the batch at the first 429 instead of burning the rest of the window', async () => {
    seen.rows = ['fb-1', 'fb-2', 'fb-3', 'fb-4', 'fb-5'];
    let calls = 0;
    const publisher = {
      reconcileFallbackRow: async (row: { id: string; opId: string | null }) => {
        calls++;
        seen.reconcile.push({ id: row.id, opId: row.opId, dedupe: fallbackDedupeKey(row.id) });
        if (calls === 3) throw rateLimited();
        return { d1JobId: row.id, pgJobId: row.id, transport: 'pg' as const, deduped: false };
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    // 2 published, then one refused publish stopped the sweep — 2 further rows
    // were never attempted even though they were selected.
    expect(calls).toBe(3);
    expect(out).toEqual({
      reconciled: 2,
      failed: 0,
      more: true,
      // All 5 were parked at sweep start; the 429 stopped the sweep partway.
      backlog: 5,
      oldestAt: PARKED_CREATED_AT,
    });
    expect(seen.reconcile.map((r) => r.id)).toEqual(['fb-1', 'fb-2', 'fb-3']);
  });

  test('a 429 on the very first publish reports zero reconciled, not a failure', async () => {
    seen.rows = ['fb-1', 'fb-2'];
    const publisher = { reconcileFallbackRow: async () => { throw rateLimited(); } };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(out).toEqual({
      reconciled: 0,
      failed: 0,
      more: true,
      // Nothing drained, so the full 2-row backlog is still parked.
      backlog: 2,
      oldestAt: PARKED_CREATED_AT,
    });
  });

  test('a non-429 error still counts as failed and does not stop the batch', async () => {
    seen.rows = ['fb-1', 'fb-2', 'fb-3'];
    const publisher = {
      reconcileFallbackRow: async (row: { id: string; opId: string | null }) => {
        seen.reconcile.push({ id: row.id, opId: row.opId, dedupe: fallbackDedupeKey(row.id) });
        if (row.id === 'fb-2') throw new Error('pg_unavailable');
        return { d1JobId: row.id, pgJobId: row.id, transport: 'pg' as const, deduped: false };
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(out).toEqual({
      reconciled: 2,
      failed: 1,
      more: false,
      // The failed row stays parked, so the 3-row backlog is still there.
      backlog: 3,
      oldestAt: PARKED_CREATED_AT,
    });
    expect(seen.reconcile.map((r) => r.id)).toEqual(['fb-1', 'fb-2', 'fb-3']);
  });

  test('a bare { code: "rate_limited" } from a non-ProducerHttpError publisher is honoured', async () => {
    seen.rows = ['fb-1', 'fb-2'];
    let calls = 0;
    const publisher = {
      reconcileFallbackRow: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('per-workspace publish limit exceeded'), { code: 'rate_limited' });
        return { d1JobId: 'x', pgJobId: 'x', transport: 'pg' as const, deduped: false };
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(calls).toBe(1);
    expect(out).toEqual({
      reconciled: 0,
      failed: 0,
      more: true,
      backlog: 2,
      oldestAt: PARKED_CREATED_AT,
    });
  });

  // SLA-349: a rate limit that reached the sweep through QueuePublisher's
  // rethrow used to arrive as a bare pg_failed, so the sweep counted it as a
  // broken row and kept going — one doomed publish per remaining row. The
  // wrapper now carries the transport code, and the sweep must read it.
  test('a 429 wrapped as pg_failed by QueuePublisher still stops the batch', async () => {
    seen.rows = ['fb-1', 'fb-2', 'fb-3'];
    let calls = 0;
    const publisher = {
      reconcileFallbackRow: async (row: { id: string; opId: string | null }) => {
        calls++;
        seen.reconcile.push({ id: row.id, opId: row.opId, dedupe: fallbackDedupeKey(row.id) });
        if (calls === 2) {
          throw new QueuePublishError('pg_failed', `PG publish failed for kind "thumb": ${row.id}`, true, {
            producerCode: 'rate_limited',
            retryAfterSeconds: 60,
          });
        }
        return { d1JobId: row.id, pgJobId: row.id, transport: 'pg' as const, deduped: false };
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(calls).toBe(2);
    expect(out).toEqual({
      reconciled: 1,
      failed: 0,
      more: true,
      backlog: 3,
      oldestAt: PARKED_CREATED_AT,
    });
  });

  // Founder feedback on SLA-317: "can you cool down this error if being
  // throttled? a.k.a. don't want to flood the log". A backlog drains at the
  // limiter's 10/minute pace while the sweep runs every 5 minutes, so the
  // warning used to repeat for the whole drain on all three containers.
  test('warns on the first throttled sweep and stays silent while it persists', async () => {
    seen.rows = ['fb-1', 'fb-2', 'fb-3'];
    const publisher = throttledPublisher();
    // Back-to-back sweeps, far inside the 15-minute default window.
    for (let i = 0; i < 5; i++) await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(seen.warns).toHaveLength(1);
    // The onset of the condition is the one line that must survive intact.
    expect(seen.warns[0]).toBe(
      '[jobs] fallback reconcile throttled by queue-api after 0 publish(es); 2 row(s) still parked',
    );
  });

  test('a clean sweep after a throttle emits nothing extra', async () => {
    seen.rows = ['fb-1'];
    await reconcileFallbackJobs({ take: 50, publisher: throttledPublisher() as never });
    expect(seen.warns).toHaveLength(1);
    // Backlog drained: the next sweep publishes and warns about nothing.
    const out = await reconcileFallbackJobs({ take: 50, publisher: okPublisher() as never });
    expect(out).toEqual({
      reconciled: 1,
      failed: 0,
      more: false,
      backlog: 1,
      oldestAt: PARKED_CREATED_AT,
    });
    expect(seen.warns).toHaveLength(1);
  });

  test('per-row failures are still reported — only the throttle line is cooled down', async () => {
    seen.rows = ['fb-1', 'fb-2'];
    const publisher = {
      reconcileFallbackRow: async (row: { id: string }) => {
        throw new Error(`pg_unavailable:${row.id}`);
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(out).toEqual({
      reconciled: 0,
      failed: 2,
      more: false,
      // Both rows stay parked after the failed republish.
      backlog: 2,
      oldestAt: PARKED_CREATED_AT,
    });
    expect(seen.warns).toHaveLength(2);
    expect(seen.warns[0]).toContain('fallback reconcile failed for fb-1: pg_unavailable:fb-1');
  });

  // SLA-354: a parked row is invisible to every claimer and to the PG-side
  // queue metrics (it lives in D1 MediaJob). The sweep reports the backlog
  // size and the reconcile lag so the maintenance worker can log a metric.
  test('reports the parked backlog and the oldest row (reconcile lag)', async () => {
    seen.rows = ['fb-1', 'fb-2', 'fb-3'];
    const out = await reconcileFallbackJobs({ take: 50, publisher: okPublisher() as never });
    expect(out.backlog).toBe(3);
    // Oldest of the ascending selection is the global oldest.
    expect(out.oldestAt).toEqual(PARKED_CREATED_AT);
    // The count reads the same fallback selection as findMany.
    expect(seen.countWhere).toEqual({ queueOwner: 'fallback_d1', status: QUEUE_FALLBACK_STATUS });
  });

  test('an empty backlog skips the count query entirely', async () => {
    seen.rows = [];
    const out = await reconcileFallbackJobs({ take: 50, publisher: okPublisher() as never });
    expect(out).toEqual({ reconciled: 0, failed: 0, more: false, backlog: 0, oldestAt: null });
    // No backlog, no extra D1 read.
    expect(seen.countCalls).toBe(0);
  });
});
