import { afterAll, describe, expect, mock, test, beforeEach } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';

// ── seams ──
// The database is faked through swapActiveClientForTests, NOT
// mock.module('../db.js'). mock.module rewrites the process-wide registry that
// every file in a `bun test` run shares, Bun cannot undo it (mock.restore()
// does not put a module back on 1.4.2), and src/db.js is imported by most of
// the app — so a fake installed here was still in place for every file that
// loaded after it. `db` is already a Proxy onto the active client, so swapping
// that client is enough and the swap is undone below for the next file.

const realJobs = await import('./jobs.js');
const realCredits = await import('./credits.js');

const enqueueCalls: Array<{ workspaceId: string; sourceId: string; payload: Record<string, unknown> }> = [];
let balanceTotal = 100;
// payloadJson of refresh jobs the mock DB answers with: keyed by status shape.
let pendingPayloads: string[] = [];
let failedPayloads: string[] = [];

const restoreStore = swapActiveClientForTests({
  source: {
    findUnique: async () => ({ sourceType: 'hashtag', platform: 'tiktok' }),
  },
  video: {
    findMany: async () => [
      { creatorHandle: 'a', platform: 'tiktok' },
      { creatorHandle: 'b', platform: 'tiktok' },
    ],
    groupBy: async () => [
      { creatorHandle: 'a', platform: 'tiktok', _count: { _all: 2 } },
      { creatorHandle: 'b', platform: 'tiktok', _count: { _all: 1 } },
    ],
  },
  mediaJob: {
    findMany: async (args: any) => {
      const status = args?.where?.status;
      if (status && typeof status === 'object' && Array.isArray(status.in)) {
        return pendingPayloads.map((payloadJson) => ({ payloadJson }));
      }
      if (status === 'failed') return failedPayloads.map((payloadJson) => ({ payloadJson }));
      return [];
    },
  },
} as unknown as AppPrismaClient);
afterAll(restoreStore);

mock.module('./credits.js', () => ({
  ...realCredits,
  creditBalance: async () => ({ planCredits: balanceTotal, packCredits: 0, total: balanceTotal }),
}));

mock.module('./jobs.js', () => ({
  ...realJobs,
  enqueueRefreshJob: async (opts: any) => {
    enqueueCalls.push({ workspaceId: opts.workspaceId, sourceId: opts.sourceId, payload: JSON.parse(opts.payload ? JSON.stringify(opts.payload) : '{}') });
    return { id: `job-${enqueueCalls.length}` };
  },
}));

import {
  needsCreatorHistory, creatorsNeedingHistory, CREATOR_HISTORY_EXTRA,
} from './creator-baselines.js';
import { CREATOR_BASELINE_MIN_SAMPLE } from '../scoring.js';

const { enqueueMissingCreatorBaselines } = await import('./creator-baselines.js');

beforeEach(() => {
  enqueueCalls.length = 0;
  balanceTotal = 100;
  pendingPayloads = [];
  failedPayloads = [];
});

describe('needsCreatorHistory', () => {
  test('one hashtag hit is not enough for an actual score', () => {
    expect(needsCreatorHistory(1)).toBe(true);
    expect(needsCreatorHistory(0)).toBe(true);
    expect(needsCreatorHistory(CREATOR_BASELINE_MIN_SAMPLE - 1)).toBe(true);
  });

  test('at the sample floor we already have an actual baseline', () => {
    expect(needsCreatorHistory(CREATOR_BASELINE_MIN_SAMPLE)).toBe(false);
    expect(needsCreatorHistory(11)).toBe(false);
  });

  test('we pull 5 extra videos for a lone hashtag hit', () => {
    expect(CREATOR_HISTORY_EXTRA).toBe(5);
  });
});

describe('creatorsNeedingHistory', () => {
  test('keeps only thin-history creators', () => {
    const out = creatorsNeedingHistory([
      { handle: 'jaredrhod', platform: 'tiktok', held: 1 },
      { handle: 'plenty', platform: 'tiktok', held: 8 },
      { handle: 'four', platform: 'tiktok', held: 4 },
    ]);
    expect(out.map(c => c.handle)).toEqual(['jaredrhod', 'four']);
  });
});

describe('enqueueMissingCreatorBaselines — the churn guards', () => {
  test('an out-of-credit workspace gets zero jobs, not jobs destined to fail', async () => {
    balanceTotal = 0;
    const res = await enqueueMissingCreatorBaselines({ workspaceId: 'ws-1', sourceId: 'src-1' });
    expect(res.queued).toBe(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  test('a creator whose baseline scrape failed recently is not re-enqueued', async () => {
    failedPayloads = [JSON.stringify({ sourceTypeOverride: 'creator', queryOverride: 'a' })];
    const res = await enqueueMissingCreatorBaselines({ workspaceId: 'ws-1', sourceId: 'src-1' });
    expect(res.queued).toBe(1);
    expect(enqueueCalls.map(c => c.payload.queryOverride)).toEqual(['b']);
  });

  test('a still-pending scrape is skipped, an affordable fresh creator is queued', async () => {
    pendingPayloads = [JSON.stringify({ sourceTypeOverride: 'creator', queryOverride: 'a' })];
    const res = await enqueueMissingCreatorBaselines({ workspaceId: 'ws-1', sourceId: 'src-1' });
    expect(res.queued).toBe(1);
    expect(enqueueCalls.map(c => c.payload.queryOverride)).toEqual(['b']);
  });

  test('both creators enqueue when funded and nothing failed or pends', async () => {
    const res = await enqueueMissingCreatorBaselines({ workspaceId: 'ws-1', sourceId: 'src-1' });
    expect(res.queued).toBe(2);
    expect(enqueueCalls.every(c => c.workspaceId === 'ws-1')).toBe(true);
  });
});
