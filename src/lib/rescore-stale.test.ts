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
/**
 * What the recent-attempt guard's MediaJob read resolves to (SLA-140). The
 * optional createdAt lets a test model an attempt OLDER than the cooldown; the
 * mock honours the query's own cutoff so the window is exercised, not assumed.
 */
let recentAttemptRow: { id: string; status: string; createdAt?: Date } | null = null;
/** What outstandingJobForSource resolves to (in-flight work already paid for). */
let outstandingRow: { status: string } | null = null;
/** Every query the guard issued, so the test can pin what it filtered on. */
const mediaJobQueries: any[] = [];
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
    mediaJob: {
      findFirst: async (args: any) => {
        mediaJobQueries.push(args);
        const row = recentAttemptRow;
        if (!row) return null;
        // Mirror the real filter instead of answering every query with the same
        // row, or the assertions prove nothing: a test that wants "inside the
        // cooldown" must not also be the test that proves "outside the cooldown"
        // is ignored, and a status filter the mock ignored would make a
        // terminal-agnostic guard indistinguishable from a failed-only one.
        const after = args?.where?.createdAt?.gt ? new Date(args.where.createdAt.gt) : null;
        if (after && row.createdAt && row.createdAt <= after) return null;
        const statusFilter = args?.where?.status;
        if (statusFilter !== undefined) {
          const matches = statusFilter === row.status
            || (Array.isArray(statusFilter.in) && statusFilter.in.includes(row.status));
          if (!matches) return null;
        }
        return { id: row.id, status: row.status };
      },
    },
  },
}));

mock.module('./jobs.js', () => ({
  ...realJobs,
  enqueueRefreshJob: async (opts: any) => {
    enqueues.push({ workspaceId: opts.workspaceId, sourceId: opts.sourceId, videoLimit: opts.videoLimit, payload: opts.payload });
    return { ...enqueueResult, id: `job-${enqueues.length}` };
  },
  outstandingJobForSource: async () => outstandingRow,
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
  recentAttemptRow = null;
  outstandingRow = null;
  mediaJobQueries.length = 0;
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

// SLA-140. The loop this pins: a refresh job for the source runs, finishes,
// and leaves the stale video at `too_fresh`. Neither pre-existing guard saw it
// — the baseline cooldown needs a scoring pass to have touched
// `Baseline.computedAt`, and the old `recentRefreshFailure` guard only matched
// terminally `failed` rows — so every sweep bought the same paid creator
// scrape again. Production, 2026-10-02: @barret.pslgod enqueued at 10:11, 10:21,
// 10:32, 10:43, 10:53, 11:04, 11:15, 11:25, 11:36, 11:48, 11:59 UTC, every
// sweep `rescored=0`.
describe('rescoreStaleTooFresh — the recent-attempt cooldown (SLA-140)', () => {
  test('a completed-but-ineffective refresh inside the cooldown is not re-bought', async () => {
    recentAttemptRow = { id: 'job-abc12345', status: 'done' };
    const res = await rescoreStaleTooFresh();
    expect(enqueues).toHaveLength(0);
    expect(res.creatorsRescraped).toBe(0);
    expect(res.creatorsAttemptCooldown).toBe(1);
    // Free recompute, so the video still leaves too_fresh instead of waiting
    // on another paid scrape to move it.
    expect(res.sourcesRescoredOnly).toBe(1);
    expect(logs.join('\n')).toContain('refresh done job-abc1');
    expect(logs.join('\n')).toContain('free recompute instead (SLA-140)');
    expect(logs.join('\n')).not.toContain('queued creator scrape');
  });

  test('repeat sweeps after a completed refresh never re-buy it', async () => {
    // The regression itself: sweep 1 pays, sweeps 2..N must not. Each sweep is
    // its own invocation, exactly as the 10-minute worker cadence produces
    // them, and every one of them saw the same completed job.
    recentAttemptRow = { id: 'job-abc12345', status: 'done' };
    for (let sweep = 0; sweep < 4; sweep++) {
      const res = await rescoreStaleTooFresh();
      expect(res.creatorsRescraped).toBe(0);
      expect(res.creatorsAttemptCooldown).toBe(1);
      expect(res.sourcesRescoredOnly).toBe(1);
    }
    expect(enqueues).toHaveLength(0);
    expect(logs.filter((l) => l.includes('queued creator scrape'))).toHaveLength(0);
  });

  // Terminal-agnostic on purpose: the case that has to be caught is `done`,
  // because `failed` was already covered by the guard this replaced.
  for (const status of ['done', 'failed', 'cancelled']) {
    test(`a ${status} attempt inside the cooldown suppresses the paid rescrape`, async () => {
      recentAttemptRow = { id: 'job-abc12345', status };
      const res = await rescoreStaleTooFresh();
      expect(enqueues).toHaveLength(0);
      expect(res.creatorsAttemptCooldown).toBe(1);
    });
  }

  test('the lookup filters on kind and time only, never on status', async () => {
    recentAttemptRow = { id: 'job-abc12345', status: 'done' };
    await rescoreStaleTooFresh();
    expect(mediaJobQueries).toHaveLength(1);
    const where = mediaJobQueries[0].where;
    expect(where.sourceId).toBe('src-1');
    expect(where.kind).toBe('refresh');
    expect(where.status).toBeUndefined();
    // createdAt window, ~6h — "did we already buy a look at this source".
    const windowMs = Date.now() - new Date(where.createdAt.gt).getTime();
    expect(Math.abs(windowMs - 6 * 3_600_000)).toBeLessThan(60_000);
  });

  test('an attempt older than the cooldown does not suppress the rescrape', async () => {
    // Bound the suppression: after the window the source is paid for again,
    // otherwise a one-off refresh would silence the rescrape forever.
    recentAttemptRow = { id: 'job-abc12345', status: 'done', createdAt: new Date(Date.now() - 7 * 3_600_000) };
    const res = await rescoreStaleTooFresh();
    expect(res.creatorsAttemptCooldown).toBe(0);
    expect(enqueues).toHaveLength(1);
    expect(res.creatorsRescraped).toBe(1);
  });

  test('an in-flight refresh is handled by the outstanding check, with no extra read', async () => {
    // Ordering is the point: work already in flight answers the question with
    // one read, so the cooldown guard is never reached — no extra D1 read per
    // group on the healthy path. The free recompute still runs, exactly as it
    // did for this branch before the guard existed.
    outstandingRow = { status: 'running' };
    recentAttemptRow = { id: 'job-abc12345', status: 'running' };
    const res = await rescoreStaleTooFresh();
    expect(enqueues).toHaveLength(0);
    expect(res.creatorsAttemptCooldown).toBe(0);
    expect(res.sourcesRescoredOnly).toBe(1);
    expect(mediaJobQueries).toHaveLength(0);
  });

  test('a failed guard read degrades to enqueueing, not to blocking', async () => {
    // The guard is best-effort: it exists to bound spend, so an unreadable
    // MediaJob must not park a stale video on the placeholder.
    const mediaJob = (await import('../db.js')).db.mediaJob as any;
    const realFindFirst = mediaJob.findFirst;
    mediaJob.findFirst = async () => {
      throw new Error('D1 read failed');
    };
    try {
      const res = await rescoreStaleTooFresh();
      expect(res.creatorsAttemptCooldown).toBe(0);
      expect(enqueues).toHaveLength(1);
      expect(res.creatorsRescraped).toBe(1);
    } finally {
      mediaJob.findFirst = realFindFirst;
    }
  });
});
