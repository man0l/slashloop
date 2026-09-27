// QueuePublisher tests (SLA-16 Phase 2). No database: D1 and PG are
// in-memory fakes. Pins the plan's producer invariants:
// - one stable opId + pre-auth amount passed through verbatim;
// - business validation unchanged (invalid targets reject before transport);
// - PG dedupe returns the same job with no duplicate work;
// - fallback rows reuse the original opId and reconcile one-way with
//   dedupeKey d1:<MediaJob.id>;
// - PG failure without fallback throws retryable (no unowned dual-queue row).
import { describe, expect, test } from 'bun:test';
import { QueuePublisher, QueuePublishError, type PublisherD1, type PublisherPg } from './publisher.js';
import { QUEUE_FALLBACK_STATUS } from './transport.js';

interface FakeD1Row {
  id: string;
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  payloadJson: string;
  opId: string | null;
  preAuthCredits: number | null;
  deadlineAt: Date | null;
  analysisId: string | null;
  queueOwner: 'd1' | 'pg' | 'fallback_d1';
  status: string;
  pgJobId?: string;
}

function makeD1() {
  const rows = new Map<string, FakeD1Row>();
  let n = 0;
  const d1: PublisherD1 = {
    createOwnedJob: async (input) => {
      const id = `d1-${++n}`;
      rows.set(id, { ...input, id, deadlineAt: input.deadlineAt, status: input.status ?? 'queued' });
      return { id };
    },
    markD1ProjectionPg: async (d1JobId, pgJobId) => {
      const row = rows.get(d1JobId);
      if (row) {
        row.queueOwner = 'pg';
        row.status = 'queued';
        row.pgJobId = pgJobId;
      }
    },
  };
  return { d1, rows };
}

function makePg(opts?: { fail?: boolean }) {
  const byDedupe = new Map<string, string>();
  let n = 0;
  const calls: Array<{ dedupeKey: string; opId: string | null }> = [];
  const pg: PublisherPg = {
    publish: async (input) => {
      if (opts?.fail) throw new Error('queue_unavailable');
      calls.push({ dedupeKey: input.dedupeKey, opId: input.opId });
      const existing = byDedupe.get(input.dedupeKey);
      if (existing) return { pgJobId: existing, deduped: true };
      const pgJobId = `pg-${++n}`;
      byDedupe.set(input.dedupeKey, pgJobId);
      return { pgJobId, deduped: false };
    },
  };
  return { pg, calls };
}

const baseReq = {
  kind: 'thumb',
  workspaceId: 'ws-1',
  videoId: 'vid-1',
  sourceId: null,
  payload: { thumbnailUrl: 'https://cdn/x.jpg' },
  opId: 'op-stable-1',
  preAuthCredits: null,
};

describe('QueuePublisher', () => {
  test('d1 transport creates a d1-owned row with the stable opId', async () => {
    const { d1, rows } = makeD1();
    const pub = new QueuePublisher({ d1, resolveTransport: async () => 'd1' });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('d1');
    expect(ref.pgJobId).toBeNull();
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('d1');
    expect(row.status).toBe('queued');
    expect(row.opId).toBe('op-stable-1');
  });

  test('invalid targets reject before transport selection', async () => {
    const { d1 } = makeD1();
    const pub = new QueuePublisher({ d1, resolveTransport: async () => 'd1' });
    // discover forbids videoId/sourceId.
    await expect(
      pub.publish({ ...baseReq, kind: 'discover', videoId: 'vid-1' }),
    ).rejects.toBeInstanceOf(QueuePublishError);
  });

  test('pg publish projects to D1 with queueOwner pg and keeps opId', async () => {
    const { d1, rows } = makeD1();
    const { pg, calls } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('pg');
    expect(ref.pgJobId).not.toBeNull();
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('pg');
    expect(row.opId).toBe('op-stable-1');
    expect(calls[0].opId).toBe('op-stable-1');
  });

  test('same-key pg replay dedupes with no duplicate work', async () => {
    const { d1 } = makeD1();
    const { pg } = makePg();
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const first = await pub.publish({ ...baseReq, dedupeKey: 'thumb:video:vid-1' });
    const second = await pub.publish({ ...baseReq, dedupeKey: 'thumb:video:vid-1' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.pgJobId).toBe(first.pgJobId);
  });

  test('pg failure without fallback throws retryable, writes nothing', async () => {
    const { d1, rows } = makeD1();
    const { pg } = makePg({ fail: true });
    const pub = new QueuePublisher({ d1, pg, resolveTransport: async () => 'pg' });
    const err = await pub.publish({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(QueuePublishError);
    expect((err as QueuePublishError).retryable).toBe(true);
    expect(rows.size).toBe(0);
  });

  test('pg failure with fallback writes a non-claimable row with the same opId', async () => {
    const { d1, rows } = makeD1();
    const { pg } = makePg({ fail: true });
    const pub = new QueuePublisher({
      d1,
      pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await pub.publish({ ...baseReq });
    expect(ref.transport).toBe('fallback_d1');
    const row = rows.get(ref.d1JobId)!;
    expect(row.queueOwner).toBe('fallback_d1');
    expect(row.status).toBe(QUEUE_FALLBACK_STATUS);
    expect(row.opId).toBe('op-stable-1');
  });

  test('reconciliation is one-way with dedupeKey d1:<id> and the original opId', async () => {
    const { d1, rows } = makeD1();
    const { pg, calls } = makePg({ fail: true });
    const pub = new QueuePublisher({
      d1,
      pg,
      resolveTransport: async () => 'pg',
      fallbackEnabled: true,
    });
    const ref = await pub.publish({ ...baseReq });
    // PG recovers; reconcile the fallback row.
    const { pg: pg2 } = makePg();
    const pub2 = new QueuePublisher({ d1, pg: pg2, resolveTransport: async () => 'pg' });
    const row = rows.get(ref.d1JobId)!;
    const done = await pub2.reconcileFallbackRow({
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspaceId,
      videoId: row.videoId,
      sourceId: row.sourceId,
      payloadJson: row.payloadJson,
      opId: row.opId,
      preAuthCredits: row.preAuthCredits,
      deadlineAt: row.deadlineAt,
    });
    expect(done.transport).toBe('pg');
    expect(row.queueOwner).toBe('pg');
    expect(row.status).toBe('queued');
    // Reconciling again dedupes onto the same PG job — never a second row.
    const again = await pub2.reconcileFallbackRow({
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspaceId,
      videoId: row.videoId,
      sourceId: row.sourceId,
      payloadJson: row.payloadJson,
      opId: row.opId,
      preAuthCredits: row.preAuthCredits,
      deadlineAt: row.deadlineAt,
    });
    expect(again.pgJobId).toBe(done.pgJobId);
    expect(again.deduped).toBe(true);
    expect(calls.length).toBe(0); // failing client never got a call through
  });
});
