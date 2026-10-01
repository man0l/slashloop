import { beforeEach, describe, expect, test } from 'bun:test';
import { setShardDirectory } from './kv.js';
import {
  D1_USAGE_PREFIX,
  DEFAULT_DAILY_READ_LIMIT,
  SYNC_MS,
  SYNC_ROWS,
  dailyReadKey,
  dailyReadLimit,
  guardDailyReads,
  localTotal,
  recordDailyReads,
  resetReadBudgetCache,
  secondsUntilUtcMidnight,
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
    process.env.D1_DAILY_READ_LIMIT = String(SYNC_ROWS * 2);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await recordDailyReads(10, AT);
    expect(fake.calls.put).toBe(0);
    expect(localTotal()).toBe(10);
  });

  test('a large batch flushes early instead of waiting out the sync window', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(SYNC_ROWS * 2);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    await recordDailyReads(SYNC_ROWS, AT);
    expect(fake.calls.put).toBe(1);
    expect(fake.store.get(dailyReadKey(AT))).toBe(String(SYNC_ROWS));
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
