// Single-owner D1 claim filter (SLA-16 Phase 2). Pins that legacy D1 claims
// select only queueOwner='d1' rows and that every enqueue writes queueOwner
// 'd1' — PG projection ('pg') and fallback ('fallback_d1') rows must never be
// selected by D1 workers.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';

const seen: {
  rawSql: string[];
  batchSql: string[];
  creates: Array<Record<string, unknown>>;
  lastCreated: Record<string, unknown> | null;
} = {
  rawSql: [],
  batchSql: [],
  creates: [],
  lastCreated: null,
};

// The D1 side of the store, faked through swapActiveClientForTests — the client
// for db.* and the executor for rawBatch — instead of mock.module('../db.js')
// and mock.module('../store.js').
//
// Both of those rewrote the process-wide module registry that every file in a
// `bun test` run shares, and Bun cannot undo a module mock (mock.restore() does
// not put it back on 1.4.2). src/cf/internal.ts imports rawBatch from
// src/store.js, so the store.js stub used to survive this file and reach the
// bridge endpoint's accounting — 5 of its 8 tests failed in CI at position #50
// and passed locally at position 2, purely on discovery order. See
// docs/test-suite-policy.md.
const restoreStore = swapActiveClientForTests(
  {
    $queryRaw: async (...args: unknown[]) => {
      const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
      seen.rawSql.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return [];
    },
    $executeRaw: async () => 0,
    mediaJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seen.creates.push(data);
        seen.lastCreated = { id: 'job-1', ...data };
        return seen.lastCreated;
      },
      findUnique: async () => seen.lastCreated,
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...seen.lastCreated, ...data }),
      findFirst: async () => null,
      findMany: async () => [],
    },
    workerControl: { findUnique: async () => null, findMany: async () => [] },
  } as unknown as AppPrismaClient,
  async (stmts: Array<{ sql: string }>) => {
    seen.batchSql.push(...stmts.map((s) => s.sql));
    return [[]];
  },
);
afterAll(restoreStore);

// The claims under test are the SQLite/D1 branch. DB_DIALECT is process-global,
// so it is set for this file's tests and put back afterwards rather than left
// behind for the next file.
const dialectBefore = process.env.DB_DIALECT;
beforeAll(() => { process.env.DB_DIALECT = 'sqlite'; });
afterAll(() => {
  if (dialectBefore === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = dialectBefore;
});

import {
  claimJobsByIds,
  claimNextJob,
  claimNextJobs,
  enqueueAnalyzeJob,
  enqueueDiscoverJob,
  enqueueFetchJob,
  enqueueRecreateJob,
  enqueueRefreshJob,
  enqueueRescoreJob,
  enqueueThumbJob,
  resetRoutedPublisherForTests,
} from './jobs.js';
import { resetTransportCacheForTests } from '../queue/transport.js';

describe('single-owner D1 claims', () => {
  test('claimNextJob filters to d1-owned rows', async () => {
    seen.rawSql.length = 0;
    await claimNextJob('thumb');
    expect(seen.rawSql.length).toBe(1);
    expect(seen.rawSql[0]).toContain(`"queueOwner" = 'd1'`);
  });

  test('claimNextJobs filters to d1-owned rows', async () => {
    seen.batchSql.length = 0;
    await claimNextJobs(['thumb', 'fetch'], 5);
    expect(seen.batchSql.length).toBe(1);
    expect(seen.batchSql[0]).toContain(`"queueOwner" = 'd1'`);
  });

  test('claimJobsByIds filters to d1-owned rows', async () => {
    seen.rawSql.length = 0;
    await claimJobsByIds(['id-1']);
    expect(seen.rawSql.length).toBe(1);
    expect(seen.rawSql[0]).toContain(`"queueOwner" = 'd1'`);
  });

  test('every enqueue writes queueOwner d1', async () => {
    resetRoutedPublisherForTests();
    resetTransportCacheForTests();
    seen.creates.length = 0;
    const ws = 'ws-1';
    await enqueueRecreateJob({ workspaceId: ws, videoId: 'v', opId: 'op', preAuthCredits: 1 });
    await enqueueFetchJob({ workspaceId: ws, videoId: 'v' });
    await enqueueThumbJob({ workspaceId: ws, videoId: 'v' });
    await enqueueAnalyzeJob({ workspaceId: ws, videoId: 'v', payload: {}, opId: 'op' });
    await enqueueDiscoverJob({
      workspaceId: ws,
      payload: { sourceType: 'keyword', query: 'q', rationale: 'r', origin: 'input' },
      opId: 'op',
      preAuthCredits: 1,
      deadlineAt: new Date(),
    });
    await enqueueRefreshJob({
      workspaceId: ws,
      sourceId: 's',
      payload: {},
      videoLimit: 10,
      deadlineAt: new Date(),
    });
    await enqueueRescoreJob({ workspaceId: ws, sourceId: 's', payload: {} });
    expect(seen.creates.length).toBe(7);
    for (const data of seen.creates) {
      expect(data.queueOwner).toBe('d1');
    }
  });

  test('pg transport without producer config fails retryable and writes nothing', async () => {
    // Single-owner: a kind resolving to pg must never silently fall back to
    // a D1 dual-write. Without queue-api credentials the enqueue fails
    // retryable so the caller retries instead of forking queue state.
    resetRoutedPublisherForTests();
    resetTransportCacheForTests();
    process.env.QUEUE_BACKEND = 'pg';
    try {
      seen.creates.length = 0;
      await expect(enqueueThumbJob({ workspaceId: 'ws-1', videoId: 'v' })).rejects.toThrow();
      expect(seen.creates.length).toBe(0);
    } finally {
      delete process.env.QUEUE_BACKEND;
      resetRoutedPublisherForTests();
      resetTransportCacheForTests();
    }
  });
});
