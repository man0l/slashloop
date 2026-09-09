// The deterministic-refusal rule in processClaimedJob's refresh paths: a
// refusal that cannot change within a retry window (out of credits, breached
// cap, deleted source) must cost ONE attempt, not all three — each extra life
// is a claim + billing reads + debit + failJob write against D1, and the
// automatic sweeps mint fresh rows every few minutes regardless.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;
const updates: Array<{ id: string; data: Row }> = [];
const refunds: Array<{ workspaceId: string; amount: number; refId: string }> = [];
let jobRow: Row = {};
let runRefreshResult: Row = {};

mock.module('../db.js', () => ({
  db: {
    mediaJob: {
      findUnique: async () => jobRow,
      update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return {}; },
      findFirst: async () => null,
      create: async () => ({}),
    },
    source: { findFirst: async () => ({ platform: 'tiktok', sourceType: 'creator', query: '@a' }) },
    video: { findFirst: async () => null },
    workspace: { findUnique: async () => null },
  },
}));

mock.module('../lib/refresh.js', () => ({
  runRefresh: async () => runRefreshResult,
  runBatchedRefresh: async () => [],
}));

mock.module('../lib/credits.js', () => ({
  CREDIT_COSTS: { refreshSourcePerVideo: 1.5, analyzeVideo: 5 },
  refundCredits: async (workspaceId: string, amount: number, _tool: string, refId: string) => {
    refunds.push({ workspaceId, amount, refId });
    return { total: 100 };
  },
  creditBalance: async () => ({ total: 100 }),
}));

mock.module('../analysis/index.js', () => ({
  analyzeVideoWithDownload: async () => { throw new Error('not under test'); },
}));

mock.module('../lib/media.js', () => ({
  ingestThumbnails: async () => ({ stored: 0, skipped: 0, failed: 0 }),
  downloadAndStoreVideo: async () => { throw new Error('not under test'); },
}));

const { processClaimedJob } = await import('./process-job.js');
const { MAX_ATTEMPTS } = await import('../lib/jobs.js');

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function refreshJob(over: Row = {}): Row {
  return {
    id: 'job-1', workspaceId: 'ws-1', videoId: null, sourceId: 'src-1',
    kind: 'refresh', status: 'running', attempts: 1,
    opId: 'op-1', preAuthCredits: 8,
    payloadJson: JSON.stringify({ sourceTypeOverride: 'creator', queryOverride: '@a' }),
    deadlineAt: null, analysisId: null,
    createdAt: minutesAgo(1), startedAt: new Date(), finishedAt: null, lastError: null,
    ...over,
  };
}

beforeEach(() => {
  updates.length = 0;
  refunds.length = 0;
  jobRow = refreshJob();
  runRefreshResult = {};
});

describe('processClaimedJob — refresh refusals', () => {
  test('insufficient_credits is terminal on the first attempt, no refund (nothing was debited)', async () => {
    runRefreshResult = { ok: false, refusal: 'insufficient_credits', errors: ['Insufficient credits: needed 8.'], pendingRefundCredits: undefined };
    const res = await processClaimedJob(refreshJob() as any);
    expect(res.ok).toBe(false);
    expect(updates[0]!.data.status).toBe('failed');
    expect(refunds).toHaveLength(0);
  });

  test('cap_breached is terminal and refunds the held pre-auth immediately', async () => {
    runRefreshResult = { ok: false, refusal: 'cap_breached', errors: ['Spend cap exceeded'], pendingRefundCredits: 8 };
    await processClaimedJob(refreshJob() as any);
    expect(updates[0]!.data.status).toBe('failed');
    expect(refunds[0]).toMatchObject({ workspaceId: 'ws-1', amount: 8, refId: 'op-1:fail' });
  });

  test('an ordinary failure still spends its retry lives (requeued at first attempt)', async () => {
    runRefreshResult = { ok: false, errors: ['actor died'], refusal: undefined, pendingRefundCredits: 8 };
    const res = await processClaimedJob(refreshJob({ attempts: 1 }) as any);
    expect(res.ok).toBe(false);
    expect(updates[0]!.data.status).toBe('queued');
    expect(refunds).toHaveLength(0);
  });

  test('an ordinary failure terminates at MAX_ATTEMPTS and refunds', async () => {
    runRefreshResult = { ok: false, errors: ['actor died'], refusal: undefined, pendingRefundCredits: 8 };
    jobRow = refreshJob({ attempts: MAX_ATTEMPTS });
    await processClaimedJob(refreshJob({ attempts: MAX_ATTEMPTS }) as any);
    expect(updates[0]!.data.status).toBe('failed');
    expect(refunds[0]).toMatchObject({ amount: 8 });
  });
});
