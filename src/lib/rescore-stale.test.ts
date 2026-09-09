// (Lives in src/lib, not src/: bun shares one module registry across test
// files, and every db.js-mocking test must sort AFTER src/store.test.ts,
// which exercises the real db client. All existing db mocks live here too.)
//
// rescoreStaleTooFresh's enqueue gate: a workspace that cannot cover the
// stale-rescrape pre-auth must get NO refresh jobs. Before this gate, every
// sweep (every ~5 min, from two workers) re-enqueued a creator scrape that was
// claimed, refused by debitCredits and failed — forever, because the videos
// stay too_fresh until a rescrape actually lands. That loop drained D1.
//
// Mocking discipline: bun re-evaluates a mocked module for every later
// importer in the run, so each mock below spreads the REAL module and
// overrides only what this file drives. db.js can't be spread (same
// trade-off as the other queue tests).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const realJobs = await import('./jobs.js');
const realCredits = await import('./credits.js');

const enqueues: Array<{ workspaceId: string; sourceId: string; videoLimit: number; payload: Record<string, unknown> }> = [];
let balanceTotal = 100;
let baselineRow: Record<string, unknown> | null = null;

mock.module('../db.js', () => ({
  db: {
    video: {
      findMany: async (args: any) => {
        // The stale scan selects on score.scoreType; batchScoreVideos' scans don't.
        if (args?.where?.score) {
          return [{
            creatorHandle: '@a', platform: 'tiktok', sourceId: 'src-1',
            postedAt: new Date(Date.now() - 72 * 3600_000),
            source: { workspaceId: 'ws-1' },
          }];
        }
        return [];
      },
    },
    source: { findUnique: async () => null },
    baseline: { findUnique: async () => baselineRow },
  },
}));

mock.module('./jobs.js', () => ({
  ...realJobs,
  enqueueRefreshJob: async (opts: any) => {
    enqueues.push({ workspaceId: opts.workspaceId, sourceId: opts.sourceId, videoLimit: opts.videoLimit, payload: opts.payload });
    return { id: `job-${enqueues.length}` };
  },
  outstandingJobForSource: async () => null,
}));

mock.module('./credits.js', () => ({
  ...realCredits,
  creditBalance: async () => ({ planCredits: balanceTotal, packCredits: 0, total: balanceTotal }),
}));

const { rescoreStaleTooFresh } = await import('../scoring.js');

beforeEach(() => {
  enqueues.length = 0;
  balanceTotal = 100;
  baselineRow = null;
});

describe('rescoreStaleTooFresh — the affordability gate', () => {
  test('an out-of-credit workspace enqueues nothing and falls back to free recompute', async () => {
    balanceTotal = 0;
    const res = await rescoreStaleTooFresh();
    expect(enqueues).toHaveLength(0);
    expect(res.creatorsRescraped).toBe(0);
    expect(res.sourcesRescoredOnly).toBe(1);
  });

  test('a funded workspace still gets its creator rescrape queued', async () => {
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsRescraped).toBe(1);
    expect(enqueues[0]).toMatchObject({
      workspaceId: 'ws-1',
      sourceId: 'src-1',
      videoLimit: 5,
      payload: { sourceTypeOverride: 'creator', queryOverride: '@a' },
    });
  });

  test('the pre-existing baseline cooldown still skips the paid scrape', async () => {
    baselineRow = { computedAt: new Date() };
    const res = await rescoreStaleTooFresh();
    expect(enqueues).toHaveLength(0);
    expect(res.creatorsRescraped).toBe(0);
    expect(res.sourcesRescoredOnly).toBe(1);
  });
});
