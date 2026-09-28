// Sweep that unparks fallback_d1 queued_remote rows via one-way PG republish.
import { describe, expect, mock, test } from 'bun:test';

const seen: { findWhere: unknown; reconcile: Array<Record<string, unknown>> } = {
  findWhere: null,
  reconcile: [],
};

mock.module('../db.js', () => ({
  db: {
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
