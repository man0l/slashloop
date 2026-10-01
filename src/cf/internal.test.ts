import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { recordBatchUsage } from '../lib/d1-usage.js';
import { setShardDirectory } from './kv.js';
import { dailyReadKey, resetReadBudgetCache, SYNC_ROWS } from './d1-read-budget.js';

/**
 * Endpoint-level cover for the daily row-read ceiling on the bridge. The
 * budget itself is unit-tested in d1-read-budget.test.ts; what matters here is
 * that the endpoint actually consults it BEFORE touching D1 and that a refusal
 * never reaches the executor.
 */

const SECRET = 'test-cron-secret';

let executed: string[][] = [];
/** Set while a test drives execution; undefined hands rawBatch back untouched. */
let executor: ((statements: { sql: string }[]) => Promise<unknown[][]>) | undefined;

/**
 * Own the executor seam instead of injecting through the store registry.
 *
 * internal.ts calls rawBatch as imported from ../store.js, and two other test
 * files (src/lib/fallback-reconcile.test.ts, src/lib/queue-owner.test.ts)
 * permanently mock.module('../store.js') with a stub whose rawBatch returns
 * `[[]]` without touching any executor. Which rawBatch internal.ts ends up with
 * therefore depends on whether this file runs before or after them — so these
 * tests only checked anything by luck of ordering. It ran 2nd locally and
 * passed; CI ran it at #50, after both mocks, and 5 of the 8 failed with a 200
 * and zero recorded executions.
 *
 * Mocking the module here and importing internal.ts afterwards pins the
 * rawBatch these assertions observe to the one internal.ts actually calls, in
 * any order. Whatever was in the module before this file — real, or another
 * file's stub — is captured as the pass-through, so this mock leaves every
 * later test file exactly as it found it.
 */
const storeBeforeMock = await import('../store.js');
const passThroughRawBatch = storeBeforeMock.rawBatch;
mock.module('../store.js', () => ({
  rawBatch: (statements: { sql: string }[]) =>
    executor ? executor(statements) : passThroughRawBatch(statements),
}));

const { POST } = await import('./internal.js');

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
  executor = fakeExecutor();
  process.env.CRON_SECRET = SECRET;
  delete process.env.D1_DAILY_READ_LIMIT;
  resetReadBudgetCache();
  setShardDirectory(kv);
});

afterEach(() => {
  // Hand rawBatch back so a later test file is not left talking to a recorder.
  executor = undefined;
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
    executor = async () => { throw new Error('D1 timeout'); };
    recordBatchUsage(600, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(500);

    // The refusal is invisible in the status of the failing call above, so a
    // caller that only ever errors would never trip the cap without this.
    executor = fakeExecutor();
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

  test('a batch response does not wait on the accounting KV write', async () => {
    process.env.D1_DAILY_READ_LIMIT = '100000000';
    // A KV put that does not settle until we release it — the shape of the
    // write this endpoint used to await before answering 200.
    let release!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { release = resolve; });
    setShardDirectory({
      get: async () => null,
      put: async () => { await writeBlocked; },
    } as unknown as KVNamespace);
    resetReadBudgetCache();
    // Big enough to cross SYNC_ROWS, so recordDailyReads flushes.
    recordBatchUsage(SYNC_ROWS * 2, 0);

    try {
      // Whichever settles first is the answer: with the accounting write off
      // the response path, the response always wins. The timeout arm only
      // exists so an awaited write fails this fast instead of hanging.
      const settled = await Promise.race([
        POST(bridge(OK_BODY)).then(() => 'response'),
        writeBlocked.then(() => 'write'),
        new Promise((r) => setTimeout(() => r('still-blocked'), 1_000)),
      ]);
      expect(settled).toBe('response');
      expect(executed).toHaveLength(1);
    } finally {
      release();
    }

    // The rows are still counted before the response goes out, so the next
    // request's guard already sees this batch's spend.
    process.env.D1_DAILY_READ_LIMIT = String(SYNC_ROWS * 2);
    recordBatchUsage(1, 0);
    expect((await POST(bridge(OK_BODY))).status).toBe(429);
  });
});
