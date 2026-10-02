import { beforeEach, describe, expect, test } from 'bun:test';
import { setShardDirectory } from './kv.js';
import {
  D1_USAGE_PREFIX,
  DEFAULT_DAILY_READ_LIMIT,
  DEGRADED_LIMIT_FRACTION,
  MAX_DAILY_WRITES,
  SYNC_MS,
  SYNC_ROWS,
  dailyReadKey,
  dailyReadLimit,
  degradedDailyReadLimit,
  guardDailyReads,
  localTotal,
  recordDailyReads,
  resetReadBudgetCache,
  secondsUntilUtcMidnight,
} from './d1-read-budget.js';

interface FakeKvOptions {
  /** Reads fail — e.g. the binding is unreachable. */
  failGet?: boolean;
  /** Writes fail — e.g. Cloudflare has refused writes past the account cap. */
  failPut?: boolean;
}

/** Minimal KVNamespace stand-in — the budget only uses get() and put(). */
function fakeKv(seed: Record<string, string> = {}, opts: FakeKvOptions = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, put: 0 };
  return {
    store,
    calls,
    get: async (key: string) => {
      calls.get++;
      if (opts.failGet) throw new Error('kv read failed');
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      calls.put++;
      if (opts.failPut) throw new Error('kv writes exhausted');
      store.set(key, value);
    },
  };
}

/** The stub above is structurally what the budget needs; cast once. */
function asKv(fake: ReturnType<typeof fakeKv>): KVNamespace {
  return fake as unknown as KVNamespace;
}

const AT = new Date('2026-10-01T09:00:00Z');

/**
 * Real now + 10s: far enough past STALE_MS that the next guard really reloads.
 * load() stamps loadedAt from Date.now(), not from the instant the caller
 * passed, so a simulated past date would never look stale.
 */
const later = () => new Date(Date.now() + 10_000);

/** The measured 2026-09-30 runaway: bridge requests, rows each, and duration. */
const RUNAWAY_REQUESTS = 33_712;
const RUNAWAY_ROWS = 2_200;
/** The twelve hours the runaway was observed over, in ms. */
const RUNAWAY_WINDOW_MS = 12 * 60 * 60 * 1000;
const RUNAWAY_STEP_MS = Math.floor(RUNAWAY_WINDOW_MS / RUNAWAY_REQUESTS);

/**
 * Drive one isolate's day the way the VPS loop drove it: `requests` batches of
 * `rowsPerRequest` rows, spread evenly over the measured twelve hours. Stops as
 * soon as the guard refuses, and reports what this isolate actually spent.
 */
async function replayRunaway(
  requests = RUNAWAY_REQUESTS,
  rowsPerRequest = RUNAWAY_ROWS,
  at: Date = AT,
): Promise<{ spent: number; requests: number }> {
  let spent = 0;
  let i = 0;
  for (; i < requests; i++) {
    const when = new Date(at.getTime() + i * RUNAWAY_STEP_MS);
    if (!(await guardDailyReads(when)).allowed) break;
    await recordDailyReads(rowsPerRequest, when);
    spent += rowsPerRequest;
  }
  return { spent, requests: i };
}

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

describe('degradedDailyReadLimit', () => {
  test('losing shared accounting may only ever lower the ceiling', () => {
    expect(degradedDailyReadLimit(4_000_000)).toBe(250_000);
    expect(degradedDailyReadLimit(1_000_000)).toBe(62_500);
    for (const limit of [2, 3, 5, 97, 4_000_000, 987_654_321]) {
      expect(degradedDailyReadLimit(limit)).toBeLessThanOrEqual(limit);
      expect(degradedDailyReadLimit(limit)).toBeGreaterThan(0);
    }
    // A ceiling of 1 row has nothing below it; the floor must not invent rows.
    expect(degradedDailyReadLimit(1)).toBe(1);
    expect(degradedDailyReadLimit(Infinity)).toBe(Infinity);
    expect(DEGRADED_LIMIT_FRACTION).toBeLessThan(1);
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

// ---------------------------------------------------------------------------
// The two failure modes the 2026-10-01 DevOps review of PR #96 measured on the
// 2026-09-30 replay. Both are regressions that only show up under load, so the
// numbers below are quoted from that replay rather than hand-waved.
// ---------------------------------------------------------------------------

describe('daily KV write budget', () => {
  test('the whole measured runaway spends the budget once, not one write per minute', async () => {
    // Ceiling deliberately far above what the runaway spends, so a refusal can
    // only come from the guard's own machinery. This is the bound that makes
    // the account-wide 1,000/day cap unreachable by tuning.
    process.env.D1_DAILY_READ_LIMIT = '100000000';
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    const { spent, requests } = await replayRunaway();

    // One flush per SYNC_MS is 1,403 writes for this replay — measured, and over
    // the 1,000/day account cap at ONE isolate before this budget existed.
    expect(fake.calls.put).toBe(MAX_DAILY_WRITES);
    expect(MAX_DAILY_WRITES).toBeLessThan(1_000);
    // It stopped early, but not by reaching the ceiling: spending the write
    // budget is what degrades it, and the REDUCED ceiling refuses. That is the
    // "fail toward a lower ceiling" behaviour working, not a budget that ran
    // out silently.
    expect(requests).toBeLessThan(RUNAWAY_REQUESTS);
    expect(spent).toBeLessThanOrEqual(degradedDailyReadLimit(100_000_000) + RUNAWAY_ROWS);
    expect((await guardDailyReads(new Date(AT.getTime() + RUNAWAY_WINDOW_MS))).degraded).toBe(true);
    // KV reads stay bounded by STALE_MS, nowhere near the 100k/day cap.
    expect(fake.calls.get).toBeLessThan(RUNAWAY_REQUESTS / 2);
  });

  test('a spent budget stops the writes and drops this isolate to the reduced ceiling', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    // Burn the daily budget: each spend crosses the early-flush bound.
    for (let i = 0; i < MAX_DAILY_WRITES; i++) await recordDailyReads(SYNC_ROWS, AT);
    expect(fake.calls.put).toBe(MAX_DAILY_WRITES);

    // Past this point nothing else reaches KV today.
    const putsAfterBudget = fake.calls.put;
    await recordDailyReads(SYNC_ROWS, AT);
    expect(fake.calls.put).toBe(putsAfterBudget);

    // ...and the rows are still counted, against a lower ceiling than before.
    const state = await guardDailyReads(AT);
    expect(state.degraded).toBe(true);
    expect(state.limit).toBe(degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT));
    expect(state.used).toBe((MAX_DAILY_WRITES + 1) * SYNC_ROWS);
  });

  test('the budget is per isolate per UTC day, not for the isolate forever', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    const fake = fakeKv();
    setShardDirectory(asKv(fake));

    // The (MAX_DAILY_WRITES + 1)-th flush is the one that finds the budget gone.
    for (let i = 0; i <= MAX_DAILY_WRITES; i++) await recordDailyReads(SYNC_ROWS, AT);
    expect((await guardDailyReads(AT)).degraded).toBe(true);

    const tomorrow = new Date('2026-10-02T00:30:00Z');
    const fresh = await guardDailyReads(tomorrow);
    expect(fresh).toMatchObject({ used: 0, degraded: false, allowed: true });
    expect(fresh.limit).toBe(DEFAULT_DAILY_READ_LIMIT);
    await recordDailyReads(SYNC_ROWS, tomorrow);
    expect(fake.calls.put).toBe(MAX_DAILY_WRITES + 1);
  });
});

describe('degraded mode fails toward a lower ceiling', () => {
  test('a KV write that fails drops the ceiling — Cloudflare does not queue writes', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    // Writes exhausted; reads still answer, and answer 0 because nothing was
    // ever persisted. This is the state the guard used to invert in.
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));

    await recordDailyReads(SYNC_ROWS, AT);
    const state = await guardDailyReads(AT);
    expect(state.degraded).toBe(true);
    expect(state.limit).toBe(degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT));
    // The rows that failed to persist are still counted locally.
    expect(state.used).toBe(SYNC_ROWS);
    expect(state.allowed).toBe(true);
  });

  test('no KV binding at all is a degraded isolate, not a full-ceiling one', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    setShardDirectory(undefined);

    expect(await guardDailyReads(AT)).toMatchObject({
      limit: degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT),
      degraded: true,
    });
  });

  test('a failed read is degraded for that load only; a failed write is sticky', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);

    setShardDirectory(asKv(fakeKv()));
    expect((await guardDailyReads(new Date())).degraded).toBe(false);

    // A read that fails leaves this isolate counting on its own memory — now...
    setShardDirectory(asKv(fakeKv({}, { failGet: true })));
    expect((await guardDailyReads(later())).degraded).toBe(true);
    // ...and the next good load clears it. One blip must not cost the day.
    setShardDirectory(asKv(fakeKv()));
    expect((await guardDailyReads(later())).degraded).toBe(false);

    // A write that fails means the platform's write cap is spent, which IS
    // sticky for the day: no amount of reading brings the shared counter back.
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));
    await recordDailyReads(SYNC_ROWS, new Date());
    expect((await guardDailyReads(later())).degraded).toBe(true);
    setShardDirectory(asKv(fakeKv()));
    expect((await guardDailyReads(later())).degraded).toBe(true);
  });

  // The module header and docs/compute-target.md both promise operators that one
  // transient KV write error degrades the isolate for the rest of the day. That
  // sentence is load-bearing — it is how an operator plans their incident — so
  // it is pinned here. It previously said the reduced ceiling "only engages
  // after three consecutive flushes", which no code implemented; there is no
  // stall counter, and one failure was always enough.
  test('one failed write degrades the day: the documented promise, pinned', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    setShardDirectory(asKv(fakeKv()));

    expect((await guardDailyReads(new Date())).limit).toBe(DEFAULT_DAILY_READ_LIMIT);

    // A single transient write error, then a perfectly healthy KV forever after.
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));
    await recordDailyReads(SYNC_ROWS, new Date());
    setShardDirectory(asKv(fakeKv()));

    const after = await guardDailyReads(later());
    expect(after.degraded).toBe(true);
    expect(after.limit).toBe(degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT));
    // Still degraded on the next load — no recovery without a new UTC day.
    expect((await guardDailyReads(later())).degraded).toBe(true);
  });

  test('the cost of one blip is most of the day, and that is the accepted trade', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    resetReadBudgetCache();
    setShardDirectory(asKv(fakeKv()));
    const healthy = await replayRunaway();

    // Same day, one failed flush at the start, healthy KV thereafter. The blip
    // is stamped AT, not new Date(): writeDegraded is sticky per UTC day, so a
    // blip recorded on a different day than replayRunaway() replays is dropped by
    // the day rollover and the isolate never degrades. That made this test pass
    // only on 2026-10-01 and fail every UTC day after it.
    resetReadBudgetCache();
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));
    await recordDailyReads(SYNC_ROWS, AT);
    setShardDirectory(asKv(fakeKv()));
    const afterBlip = await replayRunaway();

    // Quantified so a future "make it recover faster" change has to state the
    // safety cost it is buying. Tolerating N consecutive failures runs those
    // flushes at the FULL ceiling, so the per-isolate worst case becomes
    // 4,000,000 + 250,000 and the 5,000,000 platform cap is breached at two
    // concurrent isolates instead of sixteen.
    expect(afterBlip.requests).toBeLessThan(healthy.requests / 10);
    expect(afterBlip.spent).toBeLessThanOrEqual(
      degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT) + RUNAWAY_ROWS,
    );
  });

  test('runaway with KV writes exhausted: one isolate stays at the reduced ceiling', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));

    const { spent } = await replayRunaway();

    // The ceiling plus the one batch that may cross it (the check is before the
    // batch). Before this fix the same replay spent 8,003,600 rows here.
    expect(spent).toBeLessThanOrEqual(degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT) + RUNAWAY_ROWS);
    expect(spent).toBeLessThan(DEFAULT_DAILY_READ_LIMIT);
  });

  test('runaway with KV writes exhausted: four isolates stay inside the platform cap', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    // One shared KV whose writes are dead: every isolate reads 0 and grants
    // itself whatever its local ceiling says.
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));

    let total = 0;
    for (let isolate = 0; isolate < 4; isolate++) {
      resetReadBudgetCache(); // stand in for a brand-new isolate
      total += (await replayRunaway()).spent;
    }

    // 32,014,400 rows before this fix, on a 5,000,000 platform cap.
    expect(total).toBeLessThanOrEqual(4 * (degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT) + RUNAWAY_ROWS));
    expect(total).toBeLessThan(5_000_000);
  });

  test('runaway with KV writes exhausted: eight and sixteen isolates stay inside the platform cap', async () => {
    process.env.D1_DAILY_READ_LIMIT = String(DEFAULT_DAILY_READ_LIMIT);
    setShardDirectory(asKv(fakeKv({}, { failPut: true })));

    // The load-bearing case, and the reason the reduced ceiling is a sixteenth
    // rather than a quarter. At a quarter this same replay spends 8,008,000 rows
    // across eight isolates — past the 5,000,000 cap by nothing more than the
    // isolate count, which is exactly the failure class this guard exists to
    // prevent wearing a 429 as a disguise.
    for (const isolates of [8, 16]) {
      let total = 0;
      for (let isolate = 0; isolate < isolates; isolate++) {
        resetReadBudgetCache(); // stand in for a brand-new isolate
        total += (await replayRunaway()).spent;
      }
      expect(total).toBeLessThan(5_000_000);
    }
  });

  test('the reduced ceiling is sized so N isolates still total the ceiling', () => {
    // This identity is the entire safety argument for the degraded mode: with no
    // shared state the account can only be bounded by bounding each isolate, so
    // the divisor has to hold up against a plausible isolate count.
    expect(DEGRADED_LIMIT_FRACTION).toBe(1 / 16);
    const reduced = degradedDailyReadLimit(DEFAULT_DAILY_READ_LIMIT);
    expect(reduced).toBe(250_000);
    expect(16 * reduced).toBe(DEFAULT_DAILY_READ_LIMIT);
    // And it must stay strictly below the real ceiling at any scale — losing
    // shared accounting may only ever make the guard stricter.
    for (const limit of [2, 17, 1000, 250_000, DEFAULT_DAILY_READ_LIMIT, 1_000_000_000]) {
      expect(degradedDailyReadLimit(limit)).toBeLessThanOrEqual(limit);
    }
  });

  test('overlapping flushes cannot make this isolate forget rows it spent', async () => {
    process.env.D1_DAILY_READ_LIMIT = '1000000';
    // A slow KV write, so the second record lands while the first flush is
    // still awaiting — the shape the response path now allows (waitUntil).
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeKv();
    const gated = { ...fake, put: async (k: string, v: string) => { await blocked; fake.put(k, v); } };
    setShardDirectory(gated as unknown as KVNamespace);

    const first = recordDailyReads(SYNC_ROWS, AT);
    const later = new Date(AT.getTime() + SYNC_MS + 1);
    await recordDailyReads(SYNC_ROWS, later);
    release();
    await first;

    // The overlap cost a write, not a count: nothing this isolate spent is
    // forgotten, locally or once the skipped window is retried. A racing flush
    // could otherwise write `stored + its own pending` from a stale base and land
    // a LOWER number than the first — which is how a ceiling stops biting.
    expect(fake.calls.put).toBe(1);
    expect(localTotal()).toBe(2 * SYNC_ROWS);
    expect(fake.store.get(dailyReadKey(AT))).toBe(String(SYNC_ROWS));

    // The skipped window is picked up by the next record, not dropped.
    await recordDailyReads(1, new Date(later.getTime() + SYNC_MS + 1));
    expect(fake.calls.put).toBe(2);
    expect(fake.store.get(dailyReadKey(AT))).toBe(String(2 * SYNC_ROWS + 1));
  });
});
