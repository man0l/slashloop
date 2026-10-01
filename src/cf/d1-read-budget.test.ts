import { beforeEach, describe, expect, test } from 'bun:test';
import { setShardDirectory } from './kv.js';
import {
  D1_USAGE_PREFIX,
  DAILY_FLUSH_BUDGET,
  DEFAULT_DAILY_READ_LIMIT,
  DEGRADED_DIVISOR,
  MIN_SYNC_ROWS,
  STALL_FLUSH_FAILURES,
  SYNC_MS,
  budgetUsage,
  dailyReadKey,
  dailyReadLimit,
  degradedLimit,
  guardDailyReads,
  localTotal,
  recordDailyReads,
  resetReadBudgetCache,
  secondsUntilUtcMidnight,
  syncRows,
} from './d1-read-budget.js';

/** Minimal KVNamespace stand-in — the budget only uses get() and put(). */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, put: 0 };
  return {
    store,
    calls,
    get: async (key: string) => {
      calls.get++;
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      calls.put++;
      store.set(key, value);
    },
  };
}

/** The stub above is structurally what the budget needs; cast once. */
function asKv(fake: ReturnType<typeof fakeKv>): KVNamespace {
  return fake as unknown as KVNamespace;
}

const AT = new Date('2026-10-01T09:00:00Z');

beforeEach(() => {
  resetReadBudgetCache();
  setShardDirectory(undefined);
  delete process.env.D1_DAILY_READ_LIMIT;
});

describe('dailyReadKey', () => {
  test('is scoped to the UTC day so the cap resets at midnight UTC', () => {
    expect(dailyReadKey(new Date('2026-09-30T23:59:59Z'))).toBe(`${D1_USAGE_PREFIX}rows-read:2026-09-30`);
    expect(dailyReadKey(new Date('2026-10-01T00:00:00Z'))).toBe(`${D1_USAGE_PREFIX}rows-read:2026-10-01`);
  });
});

describe('secondsUntilUtcMidnight', () => {
  test('points the caller at the reset, never at zero', () => {
    expect(secondsUntilUtcMidnight(new Date('2026-10-01T23:59:59Z'))).toBe(1);
    expect(secondsUntilUtcMidnight(new Date('2026-10-01T00:00:00Z'))).toBe(86_400);
    expect(secondsUntilUtcMidnight(new Date('2026-10-01T12:00:00Z'))).toBe(43_200);
  });
});

describe('dailyReadLimit', () => {
  test('defaults below the 5M free-tier platform cap', () => {
    expect(dailyReadLimit(undefined)).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit('')).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit('   ')).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(DEFAULT_DAILY_READ_LIMIT).toBeLessThan(5_000_000);
  });

  test('0/off/none/false disable the guard outright', () => {
    for (const raw of ['0', 'off', 'OFF', 'none', 'false', 'disabled']) {
      expect(dailyReadLimit(raw)).toBe(Infinity);
    }
  });

  test('a positive integer wins, including one above the free tier', () => {
    expect(dailyReadLimit('1200')).toBe(1200);
    // A paid plan reads more: raising the ceiling is the operator's call, not
    // something to second-guess. The default is what protects the free tier.
    expect(dailyReadLimit('1e9')).toBe(1_000_000_000);
  });

  test('garbage falls back to the default instead of failing open', () => {
    for (const raw of ['lots', '-5', '1.5', 'NaN', '']) {
      expect(dailyReadLimit(raw)).toBe(DEFAULT_DAILY_READ_LIMIT);
    }
  });
});

describe('guardDailyReads', () => {
  test('allows while under the ceiling and refuses at it', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    setShardDirectory(asKv(fakeKv()));

    expect((await guardDailyReads(AT)).allowed).toBe(true);

    await recordDailyReads(999, AT);
    const under = await guardDailyReads(AT);
    expect(under.used).toBe(999);
    expect(under.allowed).toBe(true);

    await recordDailyReads(1, AT);
    const at = await guardDailyReads(AT);
    expect(at.used).toBe(1000);
    expect(at.allowed).toBe(false);
  });

  test('refuses for the whole rest of the UTC day, then a new day starts clean', async () => {
    process.env.D1_DAILY_READ_LIMIT = '100';
    setShardDirectory(asKv(fakeKv({ [dailyReadKey(AT)]: '250' })));

    const spent = await guardDailyReads(AT);
    expect(spent).toMatchObject({ used: 250, limit: 100, allowed: false });

    // 2026-10-02 reads a different key, so yesterday's 250 does not carry.
    const tomorrow = new Date('2026-10-02T00:30:00Z');
    expect(await guardDailyReads(tomorrow)).toMatchObject({ used: 0, allowed: true });
  });

  test('a disabled limit always allows and never accounts', async () => {
    process.env.D1_DAILY_READ_LIMIT = 'off';
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    expect((await guardDailyReads(AT)).limit).toBe(Infinity);
    await recordDailyReads(10_000_000, AT);
    expect((await guardDailyReads(AT)).allowed).toBe(true);
    expect(localTotal()).toBe(0);
    expect(fake.calls.put).toBe(0);
  });

  test('still counts locally when there is no KV binding at all', async () => {
    process.env.D1_DAILY_READ_LIMIT = '500';
    setShardDirectory(undefined);

    await recordDailyReads(500, AT);
    // No counter to read, but this isolate's own spend must stop the runaway —
    // an accounting outage must never turn into unlimited D1 reads.
    expect((await guardDailyReads(AT)).allowed).toBe(false);
  });

  test('a KV read error fails open but keeps counting, never throws', async () => {
    process.env.D1_DAILY_READ_LIMIT = '100';
    setShardDirectory({
      get: async () => { throw new Error('kv down'); },
      put: async () => { throw new Error('kv down'); },
    } as unknown as KVNamespace);

    expect((await guardDailyReads(AT)).allowed).toBe(true);
    await recordDailyReads(100, AT);
    expect((await guardDailyReads(AT)).allowed).toBe(false);
  });

  test('malformed, negative and missing counter values read as 0', async () => {
    process.env.D1_DAILY_READ_LIMIT = '100';
    setShardDirectory(asKv(fakeKv({ [dailyReadKey(AT)]: 'not-a-number' })));
    expect((await guardDailyReads(AT)).used).toBe(0);

    resetReadBudgetCache();
    setShardDirectory(asKv(fakeKv({ [dailyReadKey(AT)]: '-99' })));
    expect((await guardDailyReads(AT)).used).toBe(0);

    resetReadBudgetCache();
    setShardDirectory(asKv(fakeKv()));
    expect((await guardDailyReads(AT)).used).toBe(0);
  });

  test('a fresh isolate reads the persisted total (a restart cannot reset the day)', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await recordDailyReads(400, AT);
    // Still inside the sync window, so nothing has reached KV yet.
    expect(fake.store.get(dailyReadKey(AT))).toBeUndefined();
    // A later spend opens the window and flushes both.
    await recordDailyReads(100, new Date(AT.getTime() + SYNC_MS + 1));
    expect(fake.store.get(dailyReadKey(AT))).toBe('500');

    resetReadBudgetCache(); // stand in for a brand-new isolate
    expect((await guardDailyReads(AT)).used).toBe(500);
  });

  test('unflushed rows below the sync thresholds stay in memory', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(syncRows() * 2);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await recordDailyReads(10, AT);
    expect(fake.calls.put).toBe(0);
    expect(localTotal()).toBe(10);
  });

  test('a large batch flushes early instead of waiting out the sync window', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(syncRows() * 2);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await recordDailyReads(syncRows(), AT);
    expect(fake.calls.put).toBe(1);
    expect(fake.store.get(dailyReadKey(AT))).toBe(String(syncRows()));
  });

  test('a repeated KV read is served from the per-isolate cache', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await guardDailyReads(AT);
    const afterFirst = fake.calls.get;
    for (let i = 0; i < 50; i++) await guardDailyReads(AT);
    // 50 more checks must not become 50 more KV reads — the 2026-09-30 rate
    // (2,800/hour) would otherwise spend most of the KV free read tier on
    // accounting alone.
    expect(fake.calls.get).toBe(afterFirst);
  });

  test('non-positive and non-finite spend is ignored', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000';
    setShardDirectory(asKv(fakeKv()));

    await recordDailyReads(0, AT);
    await recordDailyReads(-5, AT);
    await recordDailyReads(NaN, AT);
    expect((await guardDailyReads(AT)).used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The KV write budget and the degraded mode exist because the first cut of this
// guard was measured INVERTING: with KV's account-wide write cap exhausted,
// every fresh isolate read an absent counter as 0, granted itself the full
// 4,000,000, and replayed the 2026-09-30 runaway to 8,003,600 rows at one
// isolate and 32,014,400 at four, against a 5,000,000 platform cap.
//
// These tests replay that same runaway rather than asserting the constants, so
// the property under test is "the account stays under the platform cap", not
// "the number is what I typed".
// ---------------------------------------------------------------------------

/** KV whose reads work but whose writes are rejected — Cloudflare past its cap. */
function unwritableKv(seed: Record<string, string> = {}) {
  const fake = fakeKv(seed);
  return {
    ...fake,
    put: async () => {
      fake.calls.put++;
      throw new Error('kv write limit exceeded');
    },
  };
}

const ROWS_PER_BATCH = 2_200;
const PLATFORM_CAP = 5_000_000;

/**
 * One isolate's lifetime, spent in 2026-09-30-sized batches until the guard
 * refuses. Every generation starts cold (resetReadBudgetCache), which is what
 * isolate turnover actually looks like.
 */
async function burnOneIsolate(budget: number): Promise<number> {
  let spent = 0;
  for (let i = 0; i < 5000; i++) {
    if (!(await guardDailyReads(AT)).allowed) break;
    await recordDailyReads(ROWS_PER_BATCH, AT);
    spent += ROWS_PER_BATCH;
  }
  return spent;
}

/** `generations` cold isolates in a row — what the day looks like when the counter is dead. */
async function burnRunaway(generations: number): Promise<number> {
  let total = 0;
  for (let g = 0; g < generations; g++) {
    resetReadBudgetCache();
    total += await burnOneIsolate(total);
  }
  return total;
}

describe('KV write budget', () => {
  test('a healthy day never reports a stall', async () => {
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    for (let i = 0; i < 60; i++) {
      expect((await guardDailyReads(AT)).degraded).toBe(false);
      await recordDailyReads(ROWS_PER_BATCH, AT);
    }
    expect(budgetUsage().stalled).toBe(0);
    expect(fake.calls.put).toBeGreaterThan(0);
  });

  test('replaying the runaway spends at most DAILY_FLUSH_BUDGET writes in a day', async () => {
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    // 33,712 requests x 2,200 rows is the measured 2026-09-30 rate. At the
    // default 4M ceiling the guard stops this far short of it, which is the
    // point — the replay is here to price the WRITES, not to reach the ceiling.
    await burnRunaway(4);

    expect(budgetUsage().flushes).toBeLessThanOrEqual(DAILY_FLUSH_BUDGET);
    // The previous 60s-timer design measured 1,403 writes/day for ONE isolate,
    // over the 1,000/day free cap before any other isolate is counted.
    expect(budgetUsage().flushes).toBeLessThan(1000);
  });

  test('an isolate stops writing once its daily budget is spent', async () => {
    const fake = fakeKv();
    setShardDirectory(asKv(fake));
    process.env.D1_DAILY_READ_LIMIT = String(MIN_SYNC_ROWS * 10);

    // One UTC day on purpose: step time past the 30-minute backstop or the day
    // rolls over and the per-day budget resets with it. The rows trigger alone
    // fires on every call here.
    for (let i = 0; i < 400; i++) await recordDailyReads(MIN_SYNC_ROWS, AT);

    expect(budgetUsage().flushes).toBe(DAILY_FLUSH_BUDGET);
    expect(budgetUsage().flushes).toBeLessThan(400);
  });

  test('the flush size is derived from the ceiling, so the budget covers the whole day', () => {
    // 200 writes x 20,000 rows == the 4M default ceiling, exactly once.
    expect(syncRows()).toBe(DEFAULT_DAILY_READ_LIMIT / DAILY_FLUSH_BUDGET);
    expect(DAILY_FLUSH_BUDGET * syncRows()).toBe(DEFAULT_DAILY_READ_LIMIT);
    // A raised ceiling spends its budget over a bigger slice, not more often.
    expect(syncRows(1_000_000_000)).toBe(1_000_000_000 / DAILY_FLUSH_BUDGET);
    // A tight ceiling flushes no MORE often than the floor allows.
    expect(syncRows(1000)).toBe(MIN_SYNC_ROWS);
  });
});

describe('degraded mode', () => {
  test('reports a reduced ceiling once the counter stops taking writes', async () => {
    setShardDirectory(asKv(unwritableKv()));

    const healthy = await guardDailyReads(AT);
    expect(healthy).toMatchObject({ degraded: false, limit: DEFAULT_DAILY_READ_LIMIT });

    for (let i = 0; i < STALL_FLUSH_FAILURES; i++) {
      await recordDailyReads(syncRows(), AT);
    }

    const degraded = await guardDailyReads(AT);
    expect(degraded.degraded).toBe(true);
    // DEGRADED_DIVISOLIVE isolates each spending a slice still total the
    // ceiling — that identity is the whole safety argument.
    expect(degraded.limit).toBe(degradedLimit(DEFAULT_DAILY_READ_LIMIT));
    expect(DEGRADED_DIVISOR * degradedLimit(DEFAULT_DAILY_READ_LIMIT)).toBe(DEFAULT_DAILY_READ_LIMIT);
  });

  test('a dead counter across isolate turnover stays under the platform cap', async () => {
    setShardDirectory(asKv(unwritableKv()));

    // The measured failure: 8 cold isolates, 8,003,600 and 32,014,400 rows
    // against a 5,000,000 cap. Same runaway, same 2,200-row batches.
    const spent = await burnRunaway(8);
    expect(spent).toBeLessThan(PLATFORM_CAP);
  });

  test('a stalled counter does not hand a near-exhausted day a fresh ceiling', async () => {
    // The worst shape of the inversion: the key exists, so reads succeed and
    // look trustworthy, but writes are dead so it never advances past 3.9M.
    setShardDirectory(asKv(unwritableKv({ [dailyReadKey(AT)]: '3900000' })));

    const first = await guardDailyReads(AT);
    expect(first).toMatchObject({ used: 3_900_000, degraded: false, allowed: true });

    for (let i = 0; i < STALL_FLUSH_FAILURES; i++) {
      await recordDailyReads(syncRows(), AT);
    }

    const stalled = await guardDailyReads(AT);
    expect(stalled.degraded).toBe(true);
    expect(stalled.allowed).toBe(false);
    // ~3.96M: it stopped just past the frozen counter instead of granting
    // itself another 4,000,000.
    expect(stalled.used).toBeLessThan(PLATFORM_CAP);
  });

  test('degraded mode still counts rows, it does not just refuse everything', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(MIN_SYNC_ROWS * 64);
    setShardDirectory(asKv(unwritableKv()));

    for (let i = 0; i < STALL_FLUSH_FAILURES; i++) {
      await recordDailyReads(MIN_SYNC_ROWS, AT);
    }
    const state = await guardDailyReads(AT);
    expect(state.degraded).toBe(true);
    // 64 x 20,000 = 1,280,000; a sixteenth is 80,000, and 60,000 is under it.
    expect(state.limit).toBe(80_000);
    expect(state.used).toBe(MIN_SYNC_ROWS * STALL_FLUSH_FAILURES);
    expect(state.allowed).toBe(true);

    await recordDailyReads(20_000, AT);
    expect((await guardDailyReads(AT)).allowed).toBe(false);
  });

  test('a successful flush clears the stall, so recovery is not sticky', async () => {
    const fake = fakeKv();
    setShardDirectory(asKv(fake));
    process.env.D1_DAILY_READ_LIMIT = '100000';

    // STALL_FLUSH_FAILURES - 1 failures and then a success: a transient KV blip
    // must not leave the bridge permanently in the degraded ceiling.
    let remainingFailures = STALL_FLUSH_FAILURES - 1;
    setShardDirectory({
      get: async (key: string) => fake.store.get(key) ?? null,
      put: async (key: string, value: string) => {
        if (remainingFailures-- > 0) throw new Error('kv blip');
        fake.store.set(key, value);
      },
    } as unknown as KVNamespace);

    for (let i = 0; i < STALL_FLUSH_FAILURES - 1; i++) await recordDailyReads(syncRows(), AT);
    expect(budgetUsage().stalled).toBe(STALL_FLUSH_FAILURES - 1);

    await recordDailyReads(syncRows(), AT); // succeeds, clears the stall
    expect(budgetUsage().stalled).toBe(0);
    expect((await guardDailyReads(AT)).degraded).toBe(false);
  });

  test('a disabled guard neither accounts nor degrades', async () => {
    process.env.D1_DAILY_READ_LIMIT = 'off';
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    for (let i = 0; i < 50; i++) await recordDailyReads(1_000_000, AT);
    expect(await guardDailyReads(AT)).toMatchObject({ allowed: true, degraded: false, limit: Infinity });
    expect(fake.calls.put).toBe(0);
    expect(localTotal()).toBe(0);
  });
});

describe('off the response path', () => {
  test('accounting is applied synchronously, before the returned flush promise settles', () => {
    setShardDirectory(asKv(fakeKv()));

    // Callers pin this promise with ctx.waitUntil rather than awaiting it, so
    // the ceiling has to be correct the instant recordDailyReads returns.
    recordDailyReads(4_321, AT);
    expect(localTotal()).toBe(4_321);
  });

  test('a rejected flush still leaves the rows counted', async () => {
    setShardDirectory(asKv(unwritableKv()));

    await recordDailyReads(1_234, AT); // sub-slice: counted, nothing to flush
    expect(localTotal()).toBe(1_234);
    expect(budgetUsage().stalled).toBe(0);

    await recordDailyReads(syncRows(), AT); // opens a flush window; the write is rejected
    await recordDailyReads(7_777, AT);
    // Nothing was persisted, so pending stays above the slice and every later
    // record re-opens the window. Harmless: the budget caps the writes and the
    // stall counter is already saturated, so this settles instead of thrashing
    // KV indefinitely.
    expect(localTotal()).toBe(1_234 + syncRows() + 7_777);
    expect(budgetUsage().stalled).toBe(2);
  });
});
