// Tests for queue recovery — the paths that decide whether a job is dead, and
// whether the user gets their credits back.
//
// Evidence these are written against (live DB, 215 refresh jobs):
//   - refresh drains serially at ~1 job/60s; p90 queue wait 935s, max 1937s
//   - deadlineAt is 5 minutes, so most refresh jobs run AFTER their deadline
//   - reclaimStuckJobs only ever inspected status='running', so a job that was
//     never claimed could hold a pre-auth forever
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type JobRow = {
  id: string; workspaceId: string; kind: string; status: string;
  opId: string | null; preAuthCredits: number | null;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
  lastError: string | null;
};

let jobs: JobRow[] = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
const refunds: Array<{ workspaceId: string; amount: number; kind: string; refId: string }> = [];

mock.module('../db.js', () => ({
  db: {
    mediaJob: {
      findMany: async ({ where }: any) => jobs.filter(j =>
        j.status === where.status
        && (where.createdAt?.lt ? j.createdAt < where.createdAt.lt : true)
        && (where.startedAt === null ? j.startedAt === null : true)),
      update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return {}; },
      findUnique: async ({ where }: any) => jobs.find(j => j.id === where.id) ?? null,
    },
  },
}));

mock.module('./credits.js', () => ({
  refundCredits: async (workspaceId: string, amount: number, kind: string, refId: string) => {
    refunds.push({ workspaceId, amount, kind, refId });
    return { total: 100 };
  },
  debitCredits: async () => ({ planCredits: 100, packCredits: 0, total: 100 }),
  creditBalance: async () => ({ planCredits: 100, packCredits: 0, total: 100 }),
  CREDIT_COSTS: { analyzeVideo: 15, refreshSourcePerVideo: 3 },
  InsufficientCreditsError: class extends Error {},
}));

const { failAbandonedQueuedJobs, QUEUED_ABANDONED_AFTER_MINUTES, jobCreditTool, parseDiscoverJobPayload, expandWorkerKinds, jobTimeoutMs } = await import('./jobs.js');

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1', workspaceId: 'ws-1', kind: 'refresh', status: 'queued',
    opId: 'op-1', preAuthCredits: 8,
    createdAt: minutesAgo(QUEUED_ABANDONED_AFTER_MINUTES + 10),
    startedAt: null, finishedAt: null, lastError: null,
    ...over,
  };
}

beforeEach(() => {
  jobs = [];
  updates.length = 0;
  refunds.length = 0;
});

describe('failAbandonedQueuedJobs — jobs no worker ever took', () => {
  test('a job nobody claimed is failed and its pre-auth refunded', async () => {
    jobs = [job()];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(1);
    expect(res.refunded).toBe(1);
    expect(updates[0]!.data.status).toBe('failed');
    expect(refunds[0]).toMatchObject({ workspaceId: 'ws-1', amount: 8, kind: 'refresh_source' });
  });

  test('a discover job is refunded under discover_mine, not analyze_video', async () => {
    jobs = [job({ kind: 'discover' })];
    await failAbandonedQueuedJobs();
    expect(refunds[0]).toMatchObject({ kind: 'discover_mine', amount: 8 });
  });

  test('the refund is the job\'s ACTUAL pre-auth, not a fixed price', async () => {
    // A refresh pre-auth scales with the page size; assuming the analyze
    // price would refund the wrong amount in both directions.
    jobs = [job({ preAuthCredits: 150 })];
    await failAbandonedQueuedJobs();
    expect(refunds[0]!.amount).toBe(150);
  });

  test('the refund is keyed on the job opId so reclaim paths cannot double-refund', async () => {
    jobs = [job()];
    await failAbandonedQueuedJobs();
    // Same refId reclaimStuckJobs uses — credits.ts makes it idempotent.
    expect(refunds[0]!.refId).toBe('op-1:fail');
  });

  test('a merely BACKLOGGED job is left alone', async () => {
    // p90 wait is 935s and max 1937s; cancelling a job that is simply waiting
    // its turn would destroy work that was going to run fine.
    jobs = [job({ createdAt: minutesAgo(30) })];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test('a requeued job (already ran once) is left to reclaimStuckJobs', async () => {
    // startedAt set means it HAS been claimed before — a retry, not an
    // abandoned row, and it may legitimately be old.
    jobs = [job({ startedAt: minutesAgo(50) })];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(0);
  });

  test('running jobs are never touched by this sweep', async () => {
    jobs = [job({ status: 'running', startedAt: minutesAgo(120) })];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(0);
  });

  test('a job with no opId is still failed, just not refunded', async () => {
    // Free kinds (rescore, thumb) carry no pre-auth — there is nothing to
    // give back, but the row must not stay queued forever.
    jobs = [job({ kind: 'rescore', opId: null, preAuthCredits: null })];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(1);
    expect(res.refunded).toBe(0);
  });

  test('the error message says why, and that credits came back', async () => {
    jobs = [job()];
    await failAbandonedQueuedJobs();
    const msg = String(updates[0]!.data.lastError);
    expect(msg).toMatch(/never claimed/i);
    expect(msg).toMatch(/refunded/i);
  });

  test('the threshold is far above normal queue latency', () => {
    // Measured max wait was 1937s (~32min). A threshold near that would fire
    // on healthy backlog.
    expect(QUEUED_ABANDONED_AFTER_MINUTES).toBeGreaterThan(35);
  });

  test('a caller can sweep more aggressively when it knows the queue is dead', async () => {
    jobs = [job({ createdAt: minutesAgo(20) })];
    const res = await failAbandonedQueuedJobs(10);
    expect(res.failed).toBe(1);
  });
});

describe('expandWorkerKinds', () => {
  test('a proxy refresh worker also claims discover, without a compose change', () => {
    expect(expandWorkerKinds(['refresh', 'thumb'], 'proxy')).toEqual(['refresh', 'thumb', 'discover']);
  });

  test('an Apify refresh worker does not steal discover jobs', () => {
    expect(expandWorkerKinds(['refresh', 'rescore'], 'apify')).toEqual(['refresh', 'rescore']);
  });

  test('unset kinds are left alone', () => {
    expect(expandWorkerKinds(['analyze', 'fetch'], 'proxy')).toEqual(['analyze', 'fetch']);
  });
});

describe('jobTimeoutMs', () => {
  test('scrape jobs finish or die in minutes, not the 15-minute reclaim window', () => {
    expect(jobTimeoutMs('refresh')).toBe(120_000);
    expect(jobTimeoutMs('discover')).toBe(120_000);
    expect(jobTimeoutMs('fetch')).toBe(90_000);
    expect(jobTimeoutMs('thumb')).toBe(30_000);
    expect(jobTimeoutMs('refresh')).toBeLessThan(15 * 60_000);
  });

  test('analyze sits just above OPENROUTER_VIDEO_TIMEOUT_MS', () => {
    expect(jobTimeoutMs('analyze')).toBeGreaterThanOrEqual(300_000);
  });
});

describe('jobCreditTool', () => {
  test('maps priced kinds to their ledger tool names', () => {
    expect(jobCreditTool('refresh')).toBe('refresh_source');
    expect(jobCreditTool('discover')).toBe('discover_mine');
    expect(jobCreditTool('analyze')).toBe('analyze_video');
    expect(jobCreditTool('fetch')).toBe('analyze_video');
  });
});

describe('parseDiscoverJobPayload', () => {
  test('reads a well-formed payload', () => {
    expect(parseDiscoverJobPayload(JSON.stringify({
      sourceType: 'hashtag', query: 'studytok', rationale: 'typed', origin: 'input',
    }))).toMatchObject({ sourceType: 'hashtag', query: 'studytok', origin: 'input' });
  });

  test('garbage becomes a keyword seed rather than throwing', () => {
    expect(parseDiscoverJobPayload('nope')).toMatchObject({ sourceType: 'keyword', query: '' });
  });
});
