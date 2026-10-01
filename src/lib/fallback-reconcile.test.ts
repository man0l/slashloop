// Sweep that unparks fallback_d1 queued_remote rows via one-way PG republish.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';

const seen: { findWhere: unknown; reconcile: Array<Record<string, unknown>> } = {
  findWhere: null,
  reconcile: [],
};

// The D1 side of the store, faked through swapActiveClientForTests — the client
// for db.* and the executor for rawBatch — instead of mock.module('../db.js')
// and mock.module('../store.js'). Both of those rewrote the process-wide module
// registry every file in a `bun test` run shares, and Bun cannot undo a module
// mock, so src/store.js's replacement outlived this file. src/cf/internal.ts
// imports rawBatch from that module, which is how a stub installed here reached
// the bridge endpoint's accounting depending on discovery order. See
// docs/test-suite-policy.md.
const restoreStore = swapActiveClientForTests(
  {
    mediaJob: {
      findMany: async ({ where }: { where: unknown }) => {
        seen.findWhere = where;
        return [
          {
            id: 'fb-1',
            kind: 'thumb',
            workspaceId: 'ws-1',
            videoId: 'v-1',
            sourceId: null,
            payloadJson: '{}',
            opId: 'op-original',
            preAuthCredits: 0,
            deadlineAt: null,
            analysisId: null,
          },
        ];
      },
    },
  } as unknown as AppPrismaClient,
  async () => [[]],
);
afterAll(restoreStore);

// reconcileFallbackJobs is the D1/SQLite branch. DB_DIALECT is process-global,
// so it is set for this file's tests and put back afterwards rather than left
// behind for the next file.
const dialectBefore = process.env.DB_DIALECT;
beforeAll(() => { process.env.DB_DIALECT = 'sqlite'; });
afterAll(() => {
  if (dialectBefore === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = dialectBefore;
});

import { reconcileFallbackJobs } from './jobs.js';
import { QUEUE_FALLBACK_STATUS } from '../queue/transport.js';
import { fallbackDedupeKey } from '../queue/contract.js';

describe('reconcileFallbackJobs', () => {
  test('selects fallback_d1 queued_remote and republishes with d1:<id> + original opId', async () => {
    seen.reconcile.length = 0;
    const publisher = {
      reconcileFallbackRow: async (row: { id: string; opId: string | null }) => {
        seen.reconcile.push({ id: row.id, opId: row.opId, dedupe: fallbackDedupeKey(row.id) });
        return { d1JobId: row.id, pgJobId: row.id, transport: 'pg' as const, deduped: false };
      },
    };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(seen.findWhere).toEqual({ queueOwner: 'fallback_d1', status: QUEUE_FALLBACK_STATUS });
    expect(out).toEqual({ reconciled: 1, failed: 0, more: false });
    expect(seen.reconcile).toEqual([{ id: 'fb-1', opId: 'op-original', dedupe: 'd1:fb-1' }]);
  });
});
