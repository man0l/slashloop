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
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const realJobs = await import('./jobs.js');
const realCredits = await import('./credits.js');

const enqueues: Array<{ workspaceId: string; sourceId: string; videoLimit: number; payload: Record<string, unknown> }> = [];
let balanceTotal = 100;
let baselineRow: Record<string, unknown> | null = null;
/** What the next enqueueRefreshJob resolves to (SLA-329 dedupe reporting). */
let enqueueResult: { id: string; status: string; deduped: boolean } = { id: 'job-1', status: 'queued', deduped: false };
const logs: string[] = [];

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
    return { ...enqueueResult, id: `job-${enqueues.length}` };
  },
  outstandingJobForSource: async () => null,
}));

mock.module('./credits.js', () => ({
  ...realCredits,
  creditBalance: async () => ({ planCredits: balanceTotal, packCredits: 0, total: balanceTotal }),
}));

const { rescoreStaleTooFresh } = await import('../scoring.js');

let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;
let warnSpy: ReturnType<typeof spyOn<Console, 'warn'>>;

beforeEach(() => {
  enqueues.length = 0;
  balanceTotal = 100;
  baselineRow = null;
  enqueueResult = { id: 'job-1', status: 'queued', deduped: false };
  logs.length = 0;
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
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

// SLA-329: a deduped publish creates NO job. Counting it as a queued
// creator scrape is what logged "queued ... via refresh worker" every sweep
// for four days while the videos sat at too_fresh and nothing ran.
describe('rescoreStaleTooFresh — the dedupe guardrail', () => {
  test('a deduped enqueue onto a RUNNING refresh is not counted as work queued', async () => {
    enqueueResult = { id: 'job-1', status: 'running', deduped: true };
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsRescraped).toBe(0);
    expect(res.creatorsDeduped).toBe(1);
    // The in-flight refresh will score the videos, so no free recompute either.
    expect(res.sourcesRescoredOnly).toBe(0);
    expect(logs.join('\n')).toContain('NOT rescrape-queued — deduped onto running');
    expect(logs.join('\n')).not.toContain('queued creator scrape');
  });

  test('a deduped enqueue onto a TERMINAL job falls back to the free recompute', async () => {
    enqueueResult = { id: 'job-1', status: 'done', deduped: true };
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsRescraped).toBe(0);
    expect(res.creatorsDeduped).toBe(1);
    expect(res.sourcesRescoredOnly).toBe(1);
    expect(logs.join('\n')).toContain('deduped onto TERMINAL done');
  });

  test('a real publish still logs and counts the queued scrape', async () => {
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsRescraped).toBe(1);
    expect(res.creatorsDeduped).toBe(0);
    expect(logs.join('\n')).toContain('queued creator scrape');
  });
});

// SLA-141. A dedupe onto queued/running is routine — that work IS in flight.
// A dedupe onto a terminal job creates nothing and leaves nothing queued, so
// the creator is never rescraped and its videos stay too_fresh forever. Since
// SLA-329 releases a terminal holder's dedupe key and retries the publish,
// reaching that branch again is the anomaly, and it is the exact condition
// that was invisible for four days. It must separate itself from routine
// in-flight dedupes and be loud.
describe('rescoreStaleTooFresh — the terminal-dedupe tripwire (SLA-141)', () => {
  test('an in-flight holder counts only as deduped, never as terminal', async () => {
    enqueueResult = { id: 'job-1', status: 'running', deduped: true };
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsDeduped).toBe(1);
    expect(res.creatorsDedupedTerminal).toBe(0);
  });

  test('a queued holder is in flight too, not terminal', async () => {
    enqueueResult = { id: 'job-1', status: 'queued', deduped: true };
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsDeduped).toBe(1);
    expect(res.creatorsDedupedTerminal).toBe(0);
  });

  for (const status of ['done', 'failed', 'cancelled']) {
    test(`a ${status} holder counts as terminal AND warns that nothing is in flight`, async () => {
      enqueueResult = { id: 'job-1', status, deduped: true };
      const res = await rescoreStaleTooFresh();
      expect(res.creatorsDeduped).toBe(1);
      expect(res.creatorsDedupedTerminal).toBe(1);
      const out = logs.join('\n');
      // Names the holder state, says nothing is in flight, and points at the
      // cause — an operator reading only this line must know the dedupe key
      // failed to release, not that the queue is busy.
      expect(out).toContain(`deduped onto TERMINAL ${status} job job-1`);
      expect(out).toContain('nothing in flight');
      expect(out).toContain('SLA-141');
    });
  }

  test('a real publish is neither deduped nor terminal', async () => {
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsDeduped).toBe(0);
    expect(res.creatorsDedupedTerminal).toBe(0);
  });

  test('the parked kill switch reports zeros for both counters', async () => {
    // controlEnabled comes from the real (mocked-spread) worker-control module,
    // whose db read returns null here, so default off -> the sweep runs. The
    // assertion that matters is the shape: a skipped sweep must not report a
    // terminal dedupe it never measured.
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsDedupedTerminal).toBe(0);
  });
});
