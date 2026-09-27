// Single-owner D1 claim filter (SLA-16 Phase 2). Pins that legacy D1 claims
// select only queueOwner='d1' rows and that every enqueue writes queueOwner
// 'd1' — PG projection ('pg') and fallback ('fallback_d1') rows must never be
// selected by D1 workers.
import { describe, expect, mock, test } from 'bun:test';

const seen: { rawSql: string[]; batchSql: string[]; creates: Array<Record<string, unknown>> } = {
  rawSql: [],
  batchSql: [],
  creates: [],
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
        return { id: 'job-1', ...data };
      },
      findFirst: async () => null,
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
} from './jobs.js';

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
});
