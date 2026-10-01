import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setActiveClient } from '../store.js';
import { recordBatchUsage } from '../lib/d1-usage.js';
import { setShardDirectory } from './kv.js';
import { dailyReadKey, resetReadBudgetCache } from './d1-read-budget.js';
import { POST } from './internal.js';

/**
 * Endpoint-level cover for the daily row-read ceiling on the bridge. The
 * budget itself is unit-tested in d1-read-budget.test.ts; what matters here is
 * that the endpoint actually consults it BEFORE touching D1 and that a refusal
 * never reaches the executor.
 */

const SECRET = 'test-cron-secret';

let executed: string[][] = [];

/** Fake raw executor — records what the bridge asked D1 to run. */
function fakeExecutor(rows = [] as unknown[][]) {
  return async (statements: { sql: string }[]) => {
    executed.push(statements.map((s) => s.sql));
    return statements.map(() => rows);
  };
}

function bridge(body: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request('https://mcp.slashloop.dev/internal/raw-batch', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OK_BODY = { statements: [{ sql: 'SELECT 1 FROM credits LIMIT 1', params: [] }] };

/** One KV value, enough for the bridge's accounting. */
const kv = { get: async () => null, put: async () => {} } as unknown as KVNamespace;

beforeEach(() => {
  executed = [];
  process.env.CRON_SECRET = SECRET;
  delete process.env.D1_DAILY_READ_LIMIT;
  resetReadBudgetCache();
  setShardDirectory(kv);
  setActiveClient({} as unknown as Parameters<typeof setActiveClient>[0], fakeExecutor());
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.D1_DAILY_READ_LIMIT;
  setShardDirectory(undefined);
  resetReadBudgetCache();
});

describe('POST /internal/raw-batch read ceiling', () => {
  test('serves a batch normally while the day is under budget', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    recordBatchUsage(2200, 12); // binding-side meta for the batch below

    const res = await POST(bridge(OK_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, rowsRead: 2200, rowsWritten: 12 });
    expect(executed).toHaveLength(1);
  });

  test('429s without executing once the ceiling is reached', async () => {
    process.env.D1_DAILY_READ_LIMIT = '5000';
    // Stand in for a day already spent — e.g. the runaway that motivated this.
    setShardDirectory({
      get: async (key: string) => (key === dailyReadKey() ? '5000' : null),
      put: async () => {},
    } as unknown as KVNamespace);
    resetReadBudgetCache();

    const res = await POST(bridge(OK_BODY));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'd1_daily_read_limit',
      rowsReadToday: 5000,
      rowLimit: 5000,
    });
    // The whole point: refused BEFORE spending rows on a batch nobody can use.
    expect(executed).toEqual([]);
    // Retry-After points at the UTC reset, not at a fixed guess.
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  test('a refusal does not need auth to be spent — unauthenticated callers never reach the budget', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1';
    const res = await POST(bridge(OK_BODY, 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(executed).toEqual([]);
  });

  test('a malformed request cannot consume budget', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1';
    const res = await POST(bridge({ statements: [] }));
    expect(res.status).toBe(400);
    expect(executed).toEqual([]);
  });

  test('rows spent on a failing batch still count toward the ceiling', async () => {
    process.env.D1_DAILY_READ_LIMIT = '600';
    // First batch: D1 rejects it, but it was still metered.
    setActiveClient(
      {} as unknown as Parameters<typeof setActiveClient>[0],
      async () => { throw new Error('D1 timeout'); },
    );
    recordBatchUsage(600, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(500);

    // The refusal is invisible in the status of the failing call above, so a
    // caller that only ever errors would never trip the cap without this.
    setActiveClient({} as unknown as Parameters<typeof setActiveClient>[0], fakeExecutor());
    recordBatchUsage(600, 0);
    const res = await POST(bridge(OK_BODY));
    expect(res.status).toBe(429);
    expect(executed).toEqual([]);
  });

  test('the ceiling is checked before spending, so one batch may cross it', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    recordBatchUsage(900, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(200);
    expect(executed).toHaveLength(1);

    // 900 < 1000, so this one is served too — and the 2,200 rows it spends are
    // what carry the day past the ceiling. Bounded by one request's rows, never
    // open-ended; that bound is what makes the margin in the default meaningful.
    recordBatchUsage(2200, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(200);
    expect(executed).toHaveLength(2);

    recordBatchUsage(2200, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(429);
    expect(executed).toHaveLength(2);
  });

  test('the guard is a no-op when D1_DAILY_READ_LIMIT is off', async () => {
    process.env.D1_DAILY_READ_LIMIT = 'off';
    setShardDirectory({
      get: async () => '999999999',
      put: async () => {},
    } as unknown as KVNamespace);
    resetReadBudgetCache();
    recordBatchUsage(2200, 5);

    const res = await POST(bridge(OK_BODY));
    expect(res.status).toBe(200);
    expect(executed).toHaveLength(1);
  });
});

describe('POST /internal/raw-batch metering', () => {
  test('a 429 says whether the ceiling was reduced by a dead counter', async () => {
    process.env.D1_DAILY_READ_LIMIT = '200000';
    // Reads work, writes are rejected — the counter exists and looks
    // trustworthy but can never advance.
    setShardDirectory({
      get: async (key: string) => (key === dailyReadKey() ? '0' : null),
      put: async () => { throw new Error('kv write limit exceeded'); },
    } as unknown as KVNamespace);
    resetReadBudgetCache();

    // Spend a slice per call until the stall trips and the reduced ceiling
    // takes over, then keep going: the bridge must refuse rather than keep
    // serving against a full 40,000.
    let last: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < 12; i++) {
      recordBatchUsage(20_000, 0);
      const res = await POST(bridge(OK_BODY));
      last = { status: res.status, body: (await res.json()) as Record<string, unknown> };
      if (res.status === 429) break;
    }

    expect(last?.status).toBe(429);
    expect(last?.body).toMatchObject({ error: 'd1_daily_read_limit', degraded: true });
    // 200,000 ceiling; a sixteenth is 12,500. The refusal came from the
    // REDUCED ceiling — a naive guard would have served another 140,000 rows
    // against a counter that can never move again.
    expect(last?.body.rowLimit).toBe(12_500);
    expect(last?.body.rowsReadToday).toBe(60_000);
    expect(executed.length).toBeLessThan(12);
  });

  test('a healthy refusal is not reported as degraded', async () => {
    process.env.D1_DAILY_READ_LIMIT = '5000';
    setShardDirectory({
      get: async (key: string) => (key === dailyReadKey() ? '5000' : null),
      put: async () => {},
    } as unknown as KVNamespace);
    resetReadBudgetCache();

    const res = await POST(bridge(OK_BODY));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ rowLimit: 5000, degraded: false });
  });
});
