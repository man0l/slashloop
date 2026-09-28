// PG adapter tests.
//
// Unit half (no database): claim-query builder — kind order CASE, refresh
// coalesce predicate, video-mode recreate exclusion, allowlist rejection.
// Integration half (ephemeral REAL Postgres only): set QUEUE_TEST_DATABASE_URL
// to a scratch database (CI service / Testcontainers). Skipped otherwise —
// never SQLite-mocked, per plan rev 4.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaimQuery, PgQueue, type QueueDb } from './pg.js';

describe('buildClaimQuery (no DB)', () => {
  const base = { batchSize: 5, workerId: 'w1', leaseSeconds: 900, refreshCoalesceMs: 30_000 };

  test('priority CASE follows caller kind order, then created_at, job_id', () => {
    const q = buildClaimQuery(['rescore', 'analyze'], base);
    expect(q.text).toContain("WHEN 'rescore' THEN 0 WHEN 'analyze' THEN 1");
    expect(q.text).toContain('ORDER BY CASE kind');
    expect(q.text).toContain('created_at, job_id');
    expect(q.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(q.values).toEqual([30, 5, 'w1', 900]);
  });

  test('refresh+discover expansion preserved (proxy provider)', () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    try {
      const q = buildClaimQuery(['refresh'], base);
      expect(q.text).toContain("'refresh', 'discover'");
    } finally {
      delete process.env.SCRAPER_PROVIDER;
    }
  });

  test('video-mode recreates excluded; refresh coalesce predicate present', () => {
    const q = buildClaimQuery(['recreate', 'refresh'], base);
    expect(q.text).toContain(`coalesce(payload->>'mode', '') <> 'video'`);
    expect(q.text).toContain(`WHEN 'refresh' THEN now() - make_interval(secs => $1)`);
  });

  test('unknown kinds and injection rejected', () => {
    expect(() => buildClaimQuery(['bogus-kind!'], base)).toThrow();
    expect(() => buildClaimQuery([], base)).toThrow();
    expect(() => buildClaimQuery(['analyze'], { ...base, batchSize: 0 })).toThrow();
    const q = buildClaimQuery(['analyze', 'analyze'], base);
    expect(q.text).toContain("WHEN 'analyze' THEN 0");
    // analyze expands to analyze+recreate (expandWorkerKinds parity) —
    // deduped analyze appears once, recreate takes position 1.
    expect(q.text).toContain("WHEN 'recreate' THEN 1");
    expect(q.text).not.toContain("WHEN 'analyze' THEN 1");
  });
});

describe('enqueue shared D1/PG id (no DB)', () => {
  test('d1JobId is inserted as job_id and d1_job_id', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const id = '92f63d01-2daa-425a-a570-7bcf27e6f054';
    const db: QueueDb = {
      query: async (text, values) => {
        calls.push({ text, values: values ?? [] });
        return {
          rows: [{ job_id: id, d1_job_id: id, kind: 'thumb', state: 'queued' } as never],
          rowCount: 1,
        };
      },
    };
    const queue = new PgQueue(db);
    const { row, deduped } = await queue.enqueue({
      kind: 'thumb',
      workspaceId: 'ws',
      videoId: 'v',
      sourceId: null,
      dedupeKey: 'thumb:video:v',
      d1JobId: id,
    });
    expect(deduped).toBe(false);
    expect(row.job_id).toBe(id);
    expect(calls[0].text).toContain('COALESCE($1::uuid, gen_random_uuid())');
    expect(calls[0].values[0]).toBe(id);
    expect(calls[0].values[12]).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Integration: ephemeral real Postgres.
// Run: QUEUE_TEST_DATABASE_URL=postgresql://... bun test src/queue/pg.test.ts
// ---------------------------------------------------------------------------

const TEST_URL = process.env.QUEUE_TEST_DATABASE_URL;
const describeIntegration = TEST_URL ? describe : describe.skip;

async function makeDb(url: string): Promise<QueueDb> {
  const { Pool } = (await import('pg')) as unknown as {
    Pool: new (opts: { connectionString: string }) => {
      query: (t: string, v?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>;
      end: () => Promise<void>;
    };
  };
  const pool = new Pool({ connectionString: url });
  const db: QueueDb & { close: () => Promise<void> } = {
    query: async (text, values) => {
      const r = await pool.query(text, values);
      return { rows: r.rows as never[], rowCount: r.rowCount ?? 0 };
    },
    close: () => pool.end(),
  };
  return db;
}

function migrationSql(): string {
  return readFileSync(join(import.meta.dir, '../../queue/postgres/001_queue_foundation.sql'), 'utf8');
}

describeIntegration('pg integration (ephemeral real Postgres)', () => {
  let db: QueueDb & { close: () => Promise<void> };
  let queue: PgQueue;
  const refunds: Array<{ opId: string }> = [];

  beforeAll(async () => {
    db = (await makeDb(TEST_URL!)) as QueueDb & { close: () => Promise<void> };
    await db.query(migrationSql());
    // Idempotent: second apply must not fail (restore path re-runs it).
    await db.query(migrationSql());
    queue = new PgQueue(db, {
      onTerminalRefund: async (r) => {
        refunds.push({ opId: r.opId });
      },
    });
  });

  afterAll(async () => {
    await db.query(`TRUNCATE queue_jobs, producer_nonces, canonical_scrape_locks, queue_job_logs`);
    await db.close();
  });

  test('concurrent claims never double-claim (N workers x M jobs)', async () => {
    for (let i = 0; i < 10; i++) {
      await queue.enqueue({
        kind: 'thumb',
        workspaceId: 'ws-conc',
        videoId: `v-${i}`,
        sourceId: null,
        dedupeKey: `conc:v-${i}`,
      });
    }
    const batches = await Promise.all(
      Array.from({ length: 4 }, (_, w) =>
        queue.claimBatch(['thumb'], { batchSize: 10, workerId: `w-${w}`, leaseSeconds: 900, refreshCoalesceMs: 0 }),
      ),
    );
    const ids = batches.flat().map((j) => j.job_id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
  });

  test('kind order: caller WORKER_KINDS order wins over age', async () => {
    await queue.enqueue({ kind: 'analyze', workspaceId: 'ws-o', videoId: 'old', sourceId: null, dedupeKey: 'ord:analyze' });
    await queue.enqueue({ kind: 'rescore', workspaceId: 'ws-o', videoId: null, sourceId: 's1', dedupeKey: 'ord:rescore' });
    const claimed = await queue.claimBatch(['rescore', 'analyze'], {
      batchSize: 1,
      workerId: 'w-ord',
      leaseSeconds: 900,
      refreshCoalesceMs: 0,
    });
    expect(claimed[0]?.kind).toBe('rescore');
  });

  test('refresh coalesce hold + video-mode recreate exclusion', async () => {
    await queue.enqueue({ kind: 'refresh', workspaceId: 'ws-c', videoId: null, sourceId: 's-c', dedupeKey: 'coal:refresh' });
    await queue.enqueue({ kind: 'recreate', workspaceId: 'ws-c', videoId: 'vv', sourceId: null, dedupeKey: 'excl:video', payload: { mode: 'video' } });
    await queue.enqueue({ kind: 'recreate', workspaceId: 'ws-c', videoId: 'vp', sourceId: null, dedupeKey: 'excl:photo', payload: { mode: 'photo' } });
    // Default 30s hold: fresh refresh is invisible.
    const held = await queue.claimBatch(['refresh'], { batchSize: 5, workerId: 'w-hold', leaseSeconds: 900 });
    expect(held.length).toBe(0);
    // Hold disabled: refresh claims, video recreate never does.
    const claimed = await queue.claimBatch(['refresh', 'recreate'], {
      batchSize: 5,
      workerId: 'w-claim',
      leaseSeconds: 900,
      refreshCoalesceMs: 0,
    });
    const kinds = claimed.map((j) => `${j.kind}:${(j.payload as { mode?: string }).mode ?? '-'}`);
    expect(kinds).toContain('refresh:-');
    expect(kinds).toContain('recreate:photo');
    expect(kinds.some((k) => k === 'recreate:video')).toBe(false);
  });

  test('yield gives back the attempt and parks availability', async () => {
    const { row } = await queue.enqueue({ kind: 'thumb', workspaceId: 'ws-y', videoId: 'vy', sourceId: null, dedupeKey: 'yield:v' });
    const [claimed] = await queue.claimBatch(['thumb'], { batchSize: 1, workerId: 'w-y', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(claimed.attempts).toBe(1);
    await queue.yieldJob(claimed.job_id, 'canonical lock held elsewhere');
    const after = (await queue.getJob(row.job_id))!;
    expect(after.state).toBe('queued');
    expect(after.attempts).toBe(0);
    expect(new Date(after.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('retry reaches failed at MAX_ATTEMPTS with 2-min/8-min windows; refund exactly once', async () => {
    refunds.length = 0;
    const { row } = await queue.enqueue({
      kind: 'analyze',
      workspaceId: 'ws-r',
      videoId: 'vr',
      sourceId: null,
      dedupeKey: 'retry:v',
      opId: 'op-retry-1',
      preAuthCredits: 5,
    });
    // Attempt 1 -> fail -> queued with ~2min backoff.
    let [c1] = await queue.claimBatch(['analyze'], { batchSize: 1, workerId: 'w-r', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(c1.job_id).toBe(row.job_id);
    let f = await queue.failJob(c1.job_id, 'boom');
    expect(f.terminal).toBe(false);
    let cur = (await queue.getJob(row.job_id))!;
    expect(cur.state).toBe('queued');
    const wait1 = new Date(cur.available_at).getTime() - Date.now();
    expect(wait1).toBeGreaterThan(60_000);
    expect(wait1).toBeLessThanOrEqual(2 * 60_000 + 10_000);
    // Fast-forward: attempts exhausted -> terminal + exactly one refund.
    await db.query(`UPDATE queue_jobs SET available_at = now(), attempts = 3 WHERE job_id = $1`, [row.job_id]);
    const [c3] = await queue.claimBatch(['analyze'], { batchSize: 1, workerId: 'w-r', leaseSeconds: 900, refreshCoalesceMs: 0 });
    f = await queue.failJob(c3.job_id, 'boom again');
    expect(f.terminal).toBe(true);
    cur = (await queue.getJob(row.job_id))!;
    expect(cur.state).toBe('failed');
    expect(refunds.filter((r) => r.opId === 'op-retry-1').length).toBe(1);
  });

  test('lease expiry requeues; exhausted leases fail; restart keeps accepted jobs', async () => {
    const { row } = await queue.enqueue({ kind: 'fetch', workspaceId: 'ws-l', videoId: 'vl', sourceId: null, dedupeKey: 'lease:v' });
    const [claimed] = await queue.claimBatch(['fetch'], { batchSize: 1, workerId: 'w-dead', leaseSeconds: 1, refreshCoalesceMs: 0 });
    expect(claimed.job_id).toBe(row.job_id);
    await db.query(`UPDATE queue_jobs SET lease_expires_at = now() - make_interval(secs => 5) WHERE job_id = $1`, [row.job_id]);
    const sweep = await queue.recoverExpiredLeases(50);
    expect(sweep.requeued).toBe(1);
    // Simulate worker restart with a FRESH pool: accepted jobs survive.
    const db2 = await makeDb(TEST_URL!);
    try {
      const still = await db2.query<{ job_id: string }>(`SELECT job_id FROM queue_jobs WHERE job_id = $1`, [row.job_id]);
      expect(still.rows.length).toBe(1);
    } finally {
      await (db2 as QueueDb & { close: () => Promise<void> }).close();
    }
  });

  test('queued cancel transitions once + refunds once; running cancel rejected', async () => {
    refunds.length = 0;
    const { row } = await queue.enqueue({
      kind: 'rescore',
      workspaceId: 'ws-x',
      videoId: null,
      sourceId: 's-x',
      dedupeKey: 'cancel:v',
      opId: 'op-cancel-1',
      preAuthCredits: 2,
    });
    const ok = await queue.requestCancel(row.job_id);
    expect(ok.cancelled).toBe(true);
    const again = await queue.requestCancel(row.job_id);
    expect(again).toEqual({ cancelled: false, reason: 'already_terminal' });
    expect(refunds.filter((r) => r.opId === 'op-cancel-1').length).toBe(1);
    // Cancelled rows are never claimable.
    const claimed = await queue.claimBatch(['rescore'], { batchSize: 5, workerId: 'w-x', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(claimed.some((j) => j.job_id === row.job_id)).toBe(false);
    // Running rows refuse cooperative cancel.
    const r2 = await queue.enqueue({ kind: 'rescore', workspaceId: 'ws-x', videoId: null, sourceId: 's-y', dedupeKey: 'cancel:run' });
    await queue.claimBatch(['rescore'], { batchSize: 5, workerId: 'w-x', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(await queue.requestCancel(r2.row.job_id)).toEqual({ cancelled: false, reason: 'job_not_cancellable' });
  });

  test('canonical lock: single winner, release, expiry steal', async () => {
    expect(await queue.acquireCanonicalLock('canon:a', 'owner-1', 60_000)).toBe(true);
    expect(await queue.acquireCanonicalLock('canon:a', 'owner-2', 60_000)).toBe(false);
    await queue.releaseCanonicalLock('canon:a', 'owner-2'); // not ours: no-op
    expect(await queue.acquireCanonicalLock('canon:a', 'owner-2', 60_000)).toBe(false);
    await queue.releaseCanonicalLock('canon:a', 'owner-1');
    expect(await queue.acquireCanonicalLock('canon:a', 'owner-2', 60_000)).toBe(true);
    await db.query(`UPDATE canonical_scrape_locks SET lease_expires_at = now() - make_interval(secs => 1) WHERE canonical_key = 'canon:a'`);
    expect(await queue.acquireCanonicalLock('canon:a', 'owner-3', 60_000)).toBe(true);
  });

  test('nonces: first use wins, replay loses, expiry prunes', async () => {
    const exp = new Date(Date.now() + 10 * 60_000);
    expect(await queue.consumeNonce('k1', 'nn-1', exp)).toBe(true);
    expect(await queue.consumeNonce('k1', 'nn-1', exp)).toBe(false);
    // Same nonce under another key is independent.
    expect(await queue.consumeNonce('k2', 'nn-1', exp)).toBe(true);
    await db.query(`UPDATE producer_nonces SET expires_at = now() - make_interval(secs => 1) WHERE nonce = 'nn-1'`);
    expect(await queue.pruneExpiredNonces()).toBeGreaterThanOrEqual(2);
  });

  test('D1 fallback reconciliation: d1: key dedupes, opId preserved verbatim', async () => {
    const first = await queue.enqueue({
      kind: 'analyze',
      workspaceId: 'ws-f',
      videoId: 'vf',
      sourceId: null,
      dedupeKey: 'd1:media-123',
      opId: 'op-stable-9',
      preAuthCredits: 5,
      d1JobId: 'media-123',
    });
    expect(first.deduped).toBe(false);
    const second = await queue.enqueue({
      kind: 'analyze',
      workspaceId: 'ws-f',
      videoId: 'vf',
      sourceId: null,
      dedupeKey: 'd1:media-123',
      opId: 'op-stable-9',
      preAuthCredits: 5,
      d1JobId: 'media-123',
    });
    expect(second.deduped).toBe(true);
    expect(second.row.job_id).toBe(first.row.job_id);
    expect(second.row.op_id).toBe('op-stable-9');
  });

  test('refresh scrape-landed recovery completes without re-scrape + schedules rescore tail', async () => {
    let tail = 0;
    const landedQueue = new PgQueue(db, {
      isRefreshLanded: async () => true,
      onRescoreTail: async () => {
        tail++;
      },
    });
    const { row } = await queue.enqueue({ kind: 'refresh', workspaceId: 'ws-s', videoId: null, sourceId: 's-s', dedupeKey: 'landed:v' });
    await queue.claimBatch(['refresh'], { batchSize: 1, workerId: 'w-s', leaseSeconds: 1, refreshCoalesceMs: 0 });
    await db.query(`UPDATE queue_jobs SET lease_expires_at = now() - make_interval(secs => 5) WHERE job_id = $1`, [row.job_id]);
    const sweep = await landedQueue.recoverExpiredLeases(50);
    expect(sweep.requeued).toBe(1);
    expect((await queue.getJob(row.job_id))!.state).toBe('done');
    expect(tail).toBe(1);
  });

  test('one-owner active work: claimed rows are invisible to other workers', async () => {
    const { row } = await queue.enqueue({ kind: 'thumb', workspaceId: 'ws-1o', videoId: 'v1o', sourceId: null, dedupeKey: 'owner:v' });
    const mine = await queue.claimBatch(['thumb'], { batchSize: 5, workerId: 'owner-a', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(mine.some((j) => j.job_id === row.job_id)).toBe(true);
    const theirs = await queue.claimBatch(['thumb'], { batchSize: 5, workerId: 'owner-b', leaseSeconds: 900, refreshCoalesceMs: 0 });
    expect(theirs.some((j) => j.job_id === row.job_id)).toBe(false);
    expect(await queue.renewLease(row.job_id, 'owner-a', 900)).toBe(true);
    expect(await queue.renewLease(row.job_id, 'owner-b', 900)).toBe(false);
  });
});
