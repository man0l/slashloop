// Single-owner D1 claim filter (SLA-16 Phase 2). Pins that legacy D1 claims
// select only queueOwner='d1' rows and that every enqueue writes queueOwner
// 'd1' — PG projection ('pg') and fallback ('fallback_d1') rows must never be
// selected by D1 workers.
import { afterAll, describe, expect, mock, test } from 'bun:test';

// Snapshot the REAL ../store.js by value before any mock.module runs. bun's
// mock.module rewrites the shared module registry entry for the whole `bun
// test` PROCESS and cannot be undone with mock.restore(), so this stub used to
// outlive this file: rawBatch stayed `async () => [[]]` for every later test
// file, and src/cf/internal.test.ts then read 200 from a batch that never
// touched D1 (5 failures in CI, which orders files differently than a local
// run). Restoring the real module in afterAll keeps the stub to this file.
// See also src/lib/fallback-reconcile.test.ts, which stubs the same module.
import * as realStore from '../store.js';
const REAL_STORE = { ...realStore };

afterAll(() => {
  mock.module('../store.js', () => ({ ...REAL_STORE }));
});

const seen: {
  rawSql: string[];
  batchSql: string[];
  creates: Array<Record<string, unknown>>;
  lastCreated: Record<string, unknown> | null;
  findFirstWhere: Record<string, unknown> | undefined;
} = {
  rawSql: [],
  batchSql: [],
  creates: [],
  lastCreated: null,
  findFirstWhere: undefined,
};

mock.module('../db.js', () => ({
  db: {
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
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        seen.findFirstWhere = args?.where;
        return null;
      },
      findMany: async () => [],
    },
    workerControl: { findUnique: async () => null, findMany: async () => [] },
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
  rawBatch: async (stmts: Array<{ sql: string }>) => {
    seen.batchSql.push(...stmts.map((s) => s.sql));
    return [[]];
  },
}));

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
  outstandingJobForSource,
  outstandingJobForVideo,
  resetRoutedPublisherForTests,
} from './jobs.js';
import { QUEUE_FALLBACK_STATUS, resetTransportCacheForTests } from '../queue/transport.js';

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

// SLA-141: a fallback_d1/queued_remote row is not claimable by anything, but
// the reconciler publishes it and it runs. Treating "parked" as "not
// outstanding" is what let the stale sweep re-enqueue the same paid creator
// scrape five times in 62 minutes on 2026-10-01.
describe('outstanding-job dedupe sees a parked fallback row', () => {
  // The db mock overwrites findFirstWhere on every call, so each case just
  // reads the last one — no reset needed.
  test('outstandingJobForSource counts queued_remote as outstanding', async () => {
    await outstandingJobForSource('src-1');
    expect(seen.findFirstWhere).toEqual({
      sourceId: 'src-1',
      status: { in: ['queued', 'running', QUEUE_FALLBACK_STATUS] },
      kind: 'refresh',
    });
  });

  test('the kind filter is still applied', async () => {
    await outstandingJobForSource('src-1', null);
    expect(seen.findFirstWhere).toEqual({
      sourceId: 'src-1',
      status: { in: ['queued', 'running', QUEUE_FALLBACK_STATUS] },
    });
  });

  // Deliberately NOT widened: no measurement implicates the video-scoped
  // lookup, and its callers (await_job-style waits) report `status` straight
  // back to the user. If a parked video job ever needs the same treatment it
  // gets its own evidence, not a speculative widening here.
  test('outstandingJobForVideo is unchanged', async () => {
    await outstandingJobForVideo('vid-1');
    expect(seen.findFirstWhere).toEqual({
      videoId: 'vid-1',
      status: { in: ['queued', 'running'] },
    });
  });
});
