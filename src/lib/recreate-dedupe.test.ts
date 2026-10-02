// Recreate dedupe must see a parked fallback_d1 row — SLA-341, second half.
//
// `recreateSlideshowForWorkspace` is the only recreate enqueue path (api/videos.ts
// POST ?action=recreate; there is no MCP equivalent). It gates on
// `latestJobForVideo(videoId, 'recreate')`, which filtered only
// ['queued','running','failed']. A row parked as `queued_remote` is invisible to
// every claimer — D1 claims select queueOwner='d1' only, and PG has no row yet —
// but reconcileFallbackJobs republishes it and it runs. Answering "nothing
// outstanding" for a parked row is what lets the same click through twice.
//
// This is strictly worse than the fetch half of SLA-341 (#127): the recreate
// gate sits AFTER the gate and BEFORE `debitCredits`, and every call mints a
// fresh `randomUUID()` opId, so the second `:preauth` is not a replay — it is a
// second real debit of the customer's balance for the same deck.
//
// Snapshot the REAL modules by value before any mock.module runs and put them
// back in afterAll: bun's mock.module rewrites the shared registry entry for the
// whole `bun test` PROCESS and mock.restore() does not undo it, so these stubs
// would otherwise outlive the file and break later ones. Ordering between files
// is not stable across machines. Same pattern as queue-owner.test.ts and
// fallback-reconcile.test.ts.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realDb from '../db.js';
import * as realCredits from './credits.js';
import * as realRecreateStream from './recreate-video-stream.js';

const REAL_DB = { ...realDb };
const REAL_CREDITS = { ...realCredits };
const REAL_RECREATE_STREAM = { ...realRecreateStream };

afterAll(() => {
  mock.module('../db.js', () => ({ ...REAL_DB }));
  mock.module('./credits.js', () => ({ ...REAL_CREDITS }));
  mock.module('./recreate-video-stream.js', () => ({ ...REAL_RECREATE_STREAM }));
});

const seen: {
  /** Every mediaJob.findMany where-clause the code under test asked for. */
  findManyWhere: Array<Record<string, unknown>>;
  /** Every MediaJob row written by an enqueue (one per recreate queued). */
  creates: Array<Record<string, unknown>>;
  /** refIds passed to debitCredits, in order — one per real charge. */
  debits: Array<string>;
  balance: number;
  /** Rows the mocked lookups should hand back. */
  jobs: Array<Record<string, unknown>>;
} = {
  findManyWhere: [],
  creates: [],
  debits: [],
  balance: 100,
  jobs: [],
};

/** A recreate row parked in fallback_d1 after a refused PG publish. */
function parkedRecreateRow(): Record<string, unknown> {
  return {
    id: 'parked-1',
    workspaceId: 'ws-1',
    videoId: 'vid-1',
    sourceId: null,
    kind: 'recreate',
    status: 'queued_remote',
    queueOwner: 'fallback_d1',
    attempts: 0,
    lastError: null,
    payloadJson: '{}',
    opId: 'op-parked',
    preAuthCredits: 80,
    analysisId: null,
    deadlineAt: null,
    createdAt: new Date('2026-10-02T18:16:16.000Z'),
    startedAt: null,
    finishedAt: null,
    availableAt: null,
  };
}

mock.module('../db.js', () => ({
  db: {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    video: {
      // A stored MP4 (mediaKey set) so the recreate preflight passes.
      findFirst: async () => ({ id: 'vid-1', rawJson: null, mediaStatus: 'stored', mediaKey: 'k1', durationSec: 30, thumbnailUrl: null }),
      findUnique: async () => ({ id: 'vid-1', mediaStatus: 'stored', rawJson: null, durationSec: 30, thumbnailUrl: null }),
    },
    mediaJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seen.creates.push(data);
        return { id: `job-${seen.creates.length}`, ...data };
      },
      findUnique: async () => seen.creates[seen.creates.length - 1] ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        seen.findManyWhere.push(where);
        // Honour the status filter the query asked for, so widening it is
        // observable in the outcome and not just in the captured where-clause.
        const allowed = ((where.status as { in?: string[] } | undefined)?.in) ?? [];
        return seen.jobs.filter((j) => allowed.includes(j.status as string));
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const allowed = ((where.status as { in?: string[] } | undefined)?.in) ?? [];
        return seen.jobs.find((j) => allowed.includes(j.status as string)) ?? null;
      },
      update: async () => ({}),
    },
    analysis: { findMany: async () => [] },
    score: { findUnique: async () => null },
    workerControl: { findUnique: async () => null, findMany: async () => [] },
  },
  dbDialect: () => 'sqlite',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

mock.module('./credits.js', () => ({
  ...REAL_CREDITS,
  debitCredits: async (_ws: string, amount: number, _kind: string, refId: string) => {
    seen.debits.push(refId);
    seen.balance -= amount;
    return { balanceAfter: seen.balance };
  },
  refundCredits: async (_ws: string, amount: number, _kind: string, refId: string) => {
    seen.balance += amount;
    return { balanceAfter: seen.balance };
  },
  creditBalance: async () => ({ planCredits: 0, packCredits: seen.balance, total: seen.balance }),
}));

mock.module('./recreate-video-stream.js', () => ({
  ...REAL_RECREATE_STREAM,
  driveVideoRecreateJob: async () => {},
  defaultRecreateVideoDeps: () => ({}),
}));

import { getVideoDetailForWorkspace, recreateSlideshowForWorkspace } from './video-service.js';
import { reportedJobStatus, resetRoutedPublisherForTests } from './jobs.js';
import { resetTransportCacheForTests } from '../queue/transport.js';

const WORKSPACE = { id: 'ws-1' } as never;

// The preflight refuses without an OpenRouter key; the gate under test sits past it.
const SAVED_OPENROUTER = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test-key';

// Pin the query shape: this lookup is the recreate dedupe gate's only input, and
// it filters statuses in SQL. A parked fallback_d1 row carries QUEUE_FALLBACK_STATUS.
describe('latestJobForVideo sees a parked fallback row', () => {
  test('the recreate lookup includes queued_remote', async () => {
    beforeEachReset();
    seen.jobs = [parkedRecreateRow()];
    await recreateSlideshowForWorkspace(WORKSPACE, 'vid-1');
    expect(seen.findManyWhere.length).toBeGreaterThan(0);
    for (const where of seen.findManyWhere) {
      expect((where.status as { in: string[] }).in).toContain('queued_remote');
    }
  });
});

// The CONSEQUENCE, which is the part that costs money. One click on a video whose
// first recreate is still parked must not debit the customer's balance a second
// time nor queue a second recreate job.
//
// On the pre-fix source this test observes { jobsQueued: 1, charges: 1 } — a
// second 80-credit debit and a second recreate row that the reconciler will
// later run alongside the first.
describe('recreate is not re-queued while the first is parked', () => {
  test('a parked recreate row short-circuits the gate with no new charge', async () => {
    beforeEachReset();
    seen.jobs = [parkedRecreateRow()];

    const out = await recreateSlideshowForWorkspace(WORKSPACE, 'vid-1');

    expect(out.ok).toBe(true);
    // No second job, and — the point — no second debit.
    expect({ jobsQueued: seen.creates.length, charges: seen.debits.length })
      .toEqual({ jobsQueued: 0, charges: 0 });
    if (out.ok && 'job' in out) {
      expect(out.job.id).toBe('parked-1');
      expect(out.creditsCharged).toBe(0);
    } else {
      throw new Error(`expected the existing parked job back, got ${JSON.stringify(out)}`);
    }
  });

  test('a genuinely new recreate still charges and queues exactly once', async () => {
    beforeEachReset();
    seen.jobs = [];

    const out = await recreateSlideshowForWorkspace(WORKSPACE, 'vid-1');

    expect(out.ok).toBe(true);
    expect(seen.creates).toHaveLength(1);
    expect(seen.creates[0]).toMatchObject({ kind: 'recreate', videoId: 'vid-1' });
    expect(seen.debits).toHaveLength(1);
    if (out.ok && 'job' in out) {
      // Video mode pre-auths the 8-slide max (10 credits/slide).
      expect(out.creditsCharged).toBe(80);
    } else {
      throw new Error(`expected a freshly queued recreate, got ${JSON.stringify(out)}`);
    }
  });
});

// The other half of the same bug is what the user SEES. recreateSlideshowForWorkspace
// runs in a Vercel function, where keepAlive is a no-op (runWithWaitUntil is only
// installed by the CF Worker entry, src/cf/worker.ts), so a parked recreate is
// never driven in-request — it waits for reconcileFallbackJobs. A detail
// response that reports recreateJob: null for that window is what invites the
// second click in the first place.
describe('a parked recreate still reads as in-progress on the detail endpoint', () => {
  test('recreateJob is surfaced, normalised to queued', async () => {
    beforeEachReset();
    seen.jobs = [parkedRecreateRow()];

    const detail = await getVideoDetailForWorkspace(WORKSPACE, 'vid-1');

    expect(detail?.recreateJob).toEqual({ jobId: 'parked-1', status: 'queued', lastError: null });
  });
});

describe('reportedJobStatus', () => {
  test('a parked row reports as queued — pending work, a status clients know', () => {
    expect(reportedJobStatus('queued_remote')).toBe('queued');
  });

  test('every other status passes through unchanged', () => {
    for (const s of ['queued', 'running', 'done', 'failed', 'cancelled']) {
      expect(reportedJobStatus(s)).toBe(s);
    }
  });
});

function beforeEachReset() {
  seen.findManyWhere = [];
  seen.creates = [];
  seen.debits = [];
  seen.balance = 100;
  resetRoutedPublisherForTests();
  resetTransportCacheForTests();
}