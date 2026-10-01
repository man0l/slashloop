// Sweep that unparks fallback_d1 queued_remote rows via one-way PG republish.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const seen: {
  findWhere: unknown;
  reconcile: Array<Record<string, unknown>>;
  /** Ids of rows the mocked findMany should return, oldest first. */
  rows: string[];
} = {
  findWhere: null,
  reconcile: [],
  rows: [],
};

function parkedRow(id: string): Record<string, unknown> {
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
  };
}

mock.module('../db.js', () => ({
  db: {
    mediaJob: {
      findMany: async ({ where }: { where: unknown }) => {
        seen.findWhere = where;
        return seen.rows.map((id) => parkedRow(id));
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
import { ProducerHttpError } from '../queue/producer.js';

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
});

describe('reconcileFallbackJobs', () => {
  test('selects fallback_d1 queued_remote and republishes with d1:<id> + original opId', async () => {
    seen.rows = ['fb-1'];
    const out = await reconcileFallbackJobs({ take: 50, publisher: okPublisher() as never });
    expect(seen.findWhere).toEqual({ queueOwner: 'fallback_d1', status: QUEUE_FALLBACK_STATUS });
    expect(out).toEqual({ reconciled: 1, failed: 0, more: false });
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
    expect(out).toEqual({ reconciled: 2, failed: 0, more: true });
    expect(seen.reconcile.map((r) => r.id)).toEqual(['fb-1', 'fb-2', 'fb-3']);
  });

  test('a 429 on the very first publish reports zero reconciled, not a failure', async () => {
    seen.rows = ['fb-1', 'fb-2'];
    const publisher = { reconcileFallbackRow: async () => { throw rateLimited(); } };
    const out = await reconcileFallbackJobs({ take: 50, publisher: publisher as never });
    expect(out).toEqual({ reconciled: 0, failed: 0, more: true });
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
    expect(out).toEqual({ reconciled: 2, failed: 1, more: false });
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
    expect(out).toEqual({ reconciled: 0, failed: 0, more: true });
  });
});
