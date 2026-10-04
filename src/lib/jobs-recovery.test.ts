// Tests for queue recovery — the paths that decide whether a job is dead, and
// whether the user gets their credits back.
//
// Evidence these are written against (live DB, 215 refresh jobs):
//   - refresh drains serially at ~1 job/60s; p90 queue wait 935s, max 1937s
//   - deadlineAt is 5 minutes, so most refresh jobs run AFTER their deadline
//   - reclaimStuckJobs only ever inspected status='running', so a job that was
//     never claimed could hold a pre-auth forever
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type JobRow = {
  id: string; workspaceId: string; kind: string; status: string;
  opId: string | null; preAuthCredits: number | null;
  attempts: number;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
  availableAt?: Date | null;
  lastError: string | null;
};

let jobs: JobRow[] = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
const refunds: Array<{ workspaceId: string; amount: number; kind: string; refId: string }> = [];
const batchedRefunds: Array<{ workspaceId: string; amount: number; kind: string; refId: string }> = [];
const executeRawCalls: unknown[][] = [];
const findManyCalls: Array<{ take?: number; orderBy?: unknown }> = [];
/** When set, db.mediaJob.update throws it (P2025 projection-miss tests). */
let updateError: Error | null = null;

const realCredits = await import('./credits.js');

mock.module('../db.js', () => ({
  db: {
    mediaJob: {
      findMany: async (args: any) => {
        findManyCalls.push({ take: args?.take, orderBy: args?.orderBy });
        const { where } = args;
        const notAvail = where.NOT?.availableAt?.gt as Date | undefined;
        return jobs.filter(j =>
          j.status === where.status
          && (where.createdAt?.lt ? j.createdAt < where.createdAt.lt : true)
          && (where.startedAt === null ? j.startedAt === null : true)
          && (notAvail ? (j as any).availableAt == null || (j as any).availableAt <= notAvail : true));
      },
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        if (updateError) throw updateError;
        return {};
      },
      findUnique: async ({ where }: any) => jobs.find(j => j.id === where.id) ?? null,
    },
    $executeRaw: async (...args: any[]) => { executeRawCalls.push(args); return 1; },
  },
}));

mock.module('./credits.js', () => ({
  ...realCredits,
  refundCredits: async (workspaceId: string, amount: number, kind: string, refId: string) => {
    refunds.push({ workspaceId, amount, kind, refId });
    return { total: 100 };
  },
  refundCreditsBatched: async (items: Array<{ workspaceId: string; credits: number; tool: string; refId: string }>) => {
    for (const it of items) batchedRefunds.push({ workspaceId: it.workspaceId, amount: it.credits, kind: it.tool, refId: it.refId });
    return { refunded: items.length };
  },
  debitCredits: async () => ({ planCredits: 100, packCredits: 0, total: 100 }),
  creditBalance: async () => ({ planCredits: 100, packCredits: 0, total: 100 }),
}));

const { failAbandonedQueuedJobs, QUEUED_ABANDONED_AFTER_MINUTES, jobCreditTool, parseDiscoverJobPayload, expandWorkerKinds, jobTimeoutMs, QUEUE_SWEEP_TAKE, failJob, yieldJob, requeueBackoffMs, MAX_ATTEMPTS, completeJob, setJobLifecycleSink, isPrismaRecordNotFound, recordD1ProjectionMiss, snapshotD1ProjectionMisses, resetD1ProjectionMissesForTests } = await import('./jobs.js');

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1', workspaceId: 'ws-1', kind: 'refresh', status: 'queued',
    opId: 'op-1', preAuthCredits: 8, attempts: 0,
    createdAt: minutesAgo(QUEUED_ABANDONED_AFTER_MINUTES + 10),
    startedAt: null, finishedAt: null, lastError: null,
    ...over,
  };
}

beforeEach(() => {
  jobs = [];
  updates.length = 0;
  refunds.length = 0;
  batchedRefunds.length = 0;
  executeRawCalls.length = 0;
  findManyCalls.length = 0;
});

describe('failAbandonedQueuedJobs — jobs no worker ever took', () => {
  test('a job nobody claimed is failed and its pre-auth refunded', async () => {
    jobs = [job()];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(1);
    expect(res.refunded).toBe(1);
    expect(res.more).toBe(false);
    expect(updates[0]!.data.status).toBe('failed');
    // One batched refund carrying the per-job refId (same idempotency as before).
    expect(batchedRefunds).toHaveLength(1);
    expect(batchedRefunds[0]).toMatchObject({ workspaceId: 'ws-1', amount: 8, kind: 'refresh_source' });
  });

  test('the findMany is capped at QUEUE_SWEEP_TAKE, oldest first', async () => {
    jobs = [job()];
    await failAbandonedQueuedJobs();
    expect(findManyCalls[0]).toMatchObject({
      take: QUEUE_SWEEP_TAKE,
      orderBy: { createdAt: 'asc' },
    });
  });

  test('more is true when the take cap was hit — the queue is still deep', async () => {
    jobs = Array.from({ length: QUEUE_SWEEP_TAKE }, (_, i) => job({ id: `job-${i}` }));
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(QUEUE_SWEEP_TAKE);
    expect(res.more).toBe(true);
  });

  test('a discover job is refunded under discover_mine, not analyze_video', async () => {
    jobs = [job({ kind: 'discover' })];
    await failAbandonedQueuedJobs();
    expect(batchedRefunds[0]).toMatchObject({ kind: 'discover_mine', amount: 8 });
  });

  test('the refund is the job\'s ACTUAL pre-auth, not a fixed price', async () => {
    // A refresh pre-auth scales with the page size; assuming the analyze
    // price would refund the wrong amount in both directions.
    jobs = [job({ preAuthCredits: 150 })];
    await failAbandonedQueuedJobs();
    expect(batchedRefunds[0]!.amount).toBe(150);
  });

  test('the refund is keyed on the job opId so reclaim paths cannot double-refund', async () => {
    jobs = [job()];
    await failAbandonedQueuedJobs();
    // Same refId reclaimStuckJobs uses — credits.ts makes it idempotent.
    expect(batchedRefunds[0]!.refId).toBe('op-1:fail');
  });

  test('a backoff-parked retry is exempt from the abandoned sweep', async () => {
    // failJob requeues with availableAt in the future — the sweep must not
    // terminally fail a job that is simply waiting out its cooldown.
    jobs = [job({ availableAt: new Date(Date.now() + 5 * 60_000) })];
    const res = await failAbandonedQueuedJobs();
    expect(res.failed).toBe(0);
    expect(updates).toHaveLength(0);
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
    expect(expandWorkerKinds(['analyze', 'fetch'], 'proxy')).toEqual(['analyze', 'fetch', 'recreate']);
  });
});

describe('jobTimeoutMs', () => {
  test('scrape jobs finish or die in minutes, not the 15-minute reclaim window', () => {
    expect(jobTimeoutMs('refresh')).toBe(120_000);
    expect(jobTimeoutMs('discover')).toBe(120_000);
    expect(jobTimeoutMs('fetch')).toBe(180_000);
    expect(jobTimeoutMs('recreate')).toBe(420_000); // video mode adds the Gemini slide plan
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
    expect(jobCreditTool('recreate')).toBe('recreate_slideshow');
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

describe('failJob — forced terminal for deterministic refusals', () => {
  test('the forced flag fails the job on its first attempt', async () => {
    jobs = [job({ status: 'running', attempts: 1 })];
    const res = await failJob('job-1', 'Insufficient credits', { terminal: true });
    expect(res.terminal).toBe(true);
    expect(updates[0]!.data.status).toBe('failed');
    expect(updates[0]!.data.finishedAt).toBeInstanceOf(Date);
  });

  test('without the flag a first failure still requeues', async () => {
    jobs = [job({ status: 'running', attempts: 1 })];
    const res = await failJob('job-1', 'scrape died');
    expect(res.terminal).toBe(false);
    expect(updates[0]!.data.status).toBe('queued');
  });

  test('a requeued failure parks behind availableAt (2min on first life)', async () => {
    jobs = [job({ status: 'running', attempts: 1 })];
    await failJob('job-1', 'scrape died');
    const availableAt = updates[0]!.data.availableAt as Date;
    expect(availableAt).toBeInstanceOf(Date);
    expect(availableAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(availableAt.getTime()).toBeLessThanOrEqual(Date.now() + requeueBackoffMs(1) + 5_000);
  });

  test('a terminal failure leaves availableAt alone', async () => {
    jobs = [job({ status: 'running', attempts: MAX_ATTEMPTS })];
    await failJob('job-1', 'scrape died');
    expect(updates[0]!.data.status).toBe('failed');
    expect('availableAt' in (updates[0]!.data as object)).toBe(false);
  });

  test('requeue backoff scales with the spent attempt', () => {
    expect(requeueBackoffMs(1)).toBe(2 * 60_000);
    expect(requeueBackoffMs(2)).toBe(8 * 60_000);
  });

  test('yieldJob parks the row for the contention cooldown without spending an attempt', async () => {
    await yieldJob('job-1', 'another worker is scraping');
    expect(executeRawCalls.length).toBeGreaterThan(0);
    const values = executeRawCalls.flat(2);
    const cooldown = values.find((v) => v instanceof Date) as Date | undefined;
    expect(cooldown).toBeInstanceOf(Date);
    expect(cooldown!.getTime()).toBeGreaterThan(Date.now());
  });

  test('attempts exhaustion alone still terminates, flag or not', async () => {
    jobs = [job({ status: 'running', attempts: MAX_ATTEMPTS })];
    const res = await failJob('job-1', 'scrape died');
    expect(res.terminal).toBe(true);
    expect(updates[0]!.data.status).toBe('failed');
  });
});

describe('D1 projection mirror — missing row (SLA-361)', () => {
  // The VPS worker mirrors PG terminal states onto the D1 projection row
  // (forceD1). When the row is absent the mirror used to warn P2025 on
  // complete and stay silent on fail. Both are expected gaps (PG is the
  // source of truth) that must be counted and logged once per job, never
  // warned.
  let logCalls: string[] = [];
  let warnCalls: string[] = [];
  let realLog: typeof console.log;
  let realWarn: typeof console.warn;

  const p2025 = () => Object.assign(new Error('No record was found for an update'), { code: 'P2025' });

  beforeEach(() => {
    updateError = null;
    resetD1ProjectionMissesForTests();
    // Another test file may have left a lifecycle sink installed; the mirror
    // path bypasses it via forceD1, but keep the non-forced cases honest.
    setJobLifecycleSink(null);
    logCalls = [];
    warnCalls = [];
    realLog = console.log;
    realWarn = console.warn;
    console.log = (msg?: unknown) => { logCalls.push(String(msg)); };
    console.warn = (msg?: unknown) => { warnCalls.push(String(msg)); };
  });

  afterEach(() => {
    console.log = realLog;
    console.warn = realWarn;
  });

  test('a complete mirror on a missing row resolves, counts, logs once — no warn', async () => {
    updateError = p2025();
    await expect(completeJob('d0294603', null, undefined, { forceD1: true })).resolves.toBeUndefined();
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 1, fail: 0, total: 1 });
    expect(warnCalls).toEqual([]);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain('d0294603');
    expect(logCalls[0]).toContain('total=1');
  });

  test('a P2025 on the non-forced complete still throws (that path owns the row)', async () => {
    updateError = p2025();
    await expect(completeJob('job-1', null)).rejects.toThrow();
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 0, total: 0 });
  });

  test('a healthy complete mirror still writes the row and counts nothing', async () => {
    await completeJob('job-1', 'analysis-1', '{"ok":1}', { forceD1: true });
    expect(updates[0]).toMatchObject({ id: 'job-1' });
    expect(updates[0]!.data.status).toBe('done');
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 0, total: 0 });
    expect(warnCalls).toEqual([]);
  });

  test('a fail mirror on a missing row counts, logs once, reports non-terminal', async () => {
    jobs = [];
    const res = await failJob('d0294603', 'boom', { terminal: true, forceD1: true });
    expect(res).toEqual({ terminal: false });
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 1, total: 1 });
    expect(warnCalls).toEqual([]);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain('d0294603');
  });

  test('a missing row on the non-forced fail path is just "no such job"', async () => {
    jobs = [];
    const res = await failJob('job-1', 'boom');
    expect(res).toEqual({ terminal: false });
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 0, total: 0 });
  });

  test('a fail mirror that loses its row between find and update counts, not throws', async () => {
    jobs = [job({ status: 'running', attempts: 1 })];
    updateError = p2025();
    const res = await failJob('job-1', 'boom', { terminal: true, forceD1: true });
    expect(res).toEqual({ terminal: false });
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 1, total: 1 });
    expect(warnCalls).toEqual([]);
  });

  test('a non-P2025 error on a forced mirror still propagates and is not counted', async () => {
    jobs = [job({ status: 'running', attempts: 1 })];
    updateError = new Error('boom');
    await expect(completeJob('job-1', null, undefined, { forceD1: true })).rejects.toThrow('boom');
    await expect(failJob('job-1', 'x', { forceD1: true })).rejects.toThrow('boom');
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 0, total: 0 });
  });

  test('misses accumulate per cause and the snapshot/reset seam works', () => {
    recordD1ProjectionMiss('complete');
    recordD1ProjectionMiss('fail');
    recordD1ProjectionMiss('fail');
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 1, fail: 2, total: 3 });
    resetD1ProjectionMissesForTests();
    expect(snapshotD1ProjectionMisses()).toEqual({ complete: 0, fail: 0, total: 0 });
  });

  test('isPrismaRecordNotFound recognises P2025 and nothing else', () => {
    expect(isPrismaRecordNotFound(Object.assign(new Error('x'), { code: 'P2025' }))).toBe(true);
    expect(isPrismaRecordNotFound(Object.assign(new Error('x'), { code: 'P2003' }))).toBe(false);
    expect(isPrismaRecordNotFound(new Error('x'))).toBe(false);
    expect(isPrismaRecordNotFound(null)).toBe(false);
    expect(isPrismaRecordNotFound('P2025')).toBe(false);
  });
});
