// queue-api graceful shutdown: SIGTERM drains in seconds (SLA-334), /readyz
// fails while draining, in-flight work gets a retryable 503 — no DB needed,
// the pool is stubbed the way api.test.ts stubs PgQueue.
import { describe, expect, test } from 'bun:test';
import { createShutdownController, serveQueueApi } from './server.js';
import type { QueueDb } from './pg.js';

function stubDb(): QueueDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
}

const KEYS = [{ keyId: 'k1', secret: 'test-secret', state: 'active' as const }];

async function get(port: number, path: string, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const body = await res.text();
  return { status: res.status, body };
}

describe('queue-api graceful shutdown (SLA-334)', () => {
  test('readyz is ok before shutdown, not-ready while draining, healthz stays ok', async () => {
    const exits: number[] = [];
    const svc = await serveQueueApi({
      port: 0,
      host: '127.0.0.1',
      db: stubDb(),
      keys: KEYS,
      installSignals: false,
      // Settle comfortably above the localhost round-trips below but well
      // under bun's 5s test timeout; production default is 500ms.
      settleMs: 1_500,
      graceMs: 10_000,
      exit: (c) => {
        exits.push(c);
      },
    });
    try {
      const before = await get(svc.port, '/readyz');
      expect(before.status).toBe(200);

      // Same function the SIGTERM handler calls — no real signal needed.
      const done = svc.shutdown('SIGTERM');
      expect(svc.isDraining()).toBe(true);

      const ready = await get(svc.port, '/readyz');
      expect(ready.status).toBe(503);
      expect(JSON.parse(ready.body).error.retryable).toBe(true);

      const health = await get(svc.port, '/healthz');
      expect(health.status).toBe(200);

      // New work fails fast with a retryable 5xx instead of a dropped socket.
      const enqueue = await get(svc.port, '/v1/jobs', 'POST');
      expect(enqueue.status).toBe(503);
      expect(JSON.parse(enqueue.body).error.code).toBe('queue_unavailable');

      await done;
      expect(exits).toEqual([0]);
    } finally {
      svc.server.close();
    }
  });

  test('shutdown closes the db pool and exits 0 fast', async () => {
    let dbClosed = false;
    const exits: number[] = [];
    const svc = await serveQueueApi({
      port: 0,
      host: '127.0.0.1',
      db: stubDb(),
      closeDb: async () => {
        dbClosed = true;
      },
      keys: KEYS,
      installSignals: false,
      graceMs: 5_000,
      exit: (c) => {
        exits.push(c);
      },
    });
    const t = Date.now();
    await svc.shutdown('SIGTERM');
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(dbClosed).toBe(true);
    expect(exits).toEqual([0]);
    svc.server.close();
  });

  test('a stuck listener cannot hold the deploy open past the grace period', async () => {
    const exits: number[] = [];
    const ctl = createShutdownController({
      closeServer: () => new Promise<void>(() => {}), // never resolves
      closeDb: async () => {},
      graceMs: 50,
      settleMs: 0,
      exit: (c) => {
        exits.push(c);
      },
      log: () => {},
    });
    const t = Date.now();
    await ctl.shutdown('SIGTERM');
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(exits).toEqual([0]);
  });

  test('shutdown is idempotent — double SIGTERM drains once', async () => {
    let closes = 0;
    let exits: number[] = [];
    const ctl = createShutdownController({
      closeServer: async () => {
        closes += 1;
      },
      closeDb: async () => {},
      graceMs: 1_000,
      exit: (c) => {
        exits.push(c);
      },
      log: () => {},
    });
    await Promise.all([ctl.shutdown('SIGTERM'), ctl.shutdown('SIGTERM')]);
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });
});
