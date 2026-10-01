// ---------------------------------------------------------------------------
// Daily row-read ceiling for the /internal/raw-batch bridge.
//
// Why this exists (2026-09-30, SLA-195): the account sits on D1's free tier,
// which caps an ACCOUNT at 5M rows read per UTC day. One runaway client — the
// VPS worker containers looping on rawBatch — spent 74.3M rows on that cap in
// twelve hours: 33,712 bridge requests, ~2,200 rows each, flat from 00:00Z to
// 11:00Z. The blast radius is the whole account, not the client: once the cap
// is reached every D1 read on EVERY database in the account fails with
// Cloudflare error 7500 until midnight UTC, so an unrelated read-only query in
// another product on the same account starts failing too.
//
// The existing guardrails do not cover this. src/lib/circuit-breaker.ts opens
// only when D1 is ALREADY failing; the runaway was succeeding, just far too
// often. src/cf/d1-budget.ts caps queries per single request (AsyncLocalStorage
// scope), not rows per day. So the bridge had no volume ceiling at all.
//
// Scope: rows READ, on this bridge only. The cap that actually bit us is the
// read cap; the free tier's write cap (100k/day) is nowhere near. Narrow scope
// on purpose — this must not start failing ordinary reads, and it must never
// fail the money paths (credit refunds in src/lib/credits.ts run through
// rawBatch) for a reason other than "the account's read budget is spent".
//
// ---------------------------------------------------------------------------
// Accounting storage: KV, never D1.
//
// A D1 row counter would consume the rows it exists to protect, and at 7500
// it would be unreadable anyway. The counter lives in the SHARD_DIRECTORY KV
// namespace (src/cf/kv.ts) under a `d1-usage:` prefix — that namespace already
// holds Worker-only state (the digest sweep cursor) and costs no D1 rows.
//
// Consistency is deliberately SOFT, but softness is no longer the thing that
// decides whether the ceiling holds. Two independent defenses, because the
// first cut of this module was measured failing:
//
// 1. WRITES ARE BUDGETED. KV's free tier allows 1,000 writes/day, ACCOUNT-WIDE
//    and shared with every other namespace including the digest cursor. The
//    first cut flushed on a 60s timer — 1,440 writes/day for a SINGLE isolate,
//    over the cap before any other isolate is counted, and linear in theirs.
//    Worse, Cloudflare *rejects* writes past the cap rather than queueing them,
//    so an exhausted account silently removes the counter out from under the
//    guard. Now every isolate stops writing after DAILY_FLUSH_BUDGET (200)
//    flushes in a UTC day: at the ~4 isolates this account runs that is 800 of
//    the 1,000 available. The flush size is therefore derived, not chosen —
//    syncRows(limit) = limit / DAILY_FLUSH_BUDGET, so DAILY_FLUSH_BUDGET writes
//    walk the entire ceiling exactly once. Every extra write buys back
//    cross-isolate accuracy and there are only 200 to spend.
//
// 2. A CEILING THAT SHRINKS WHEN IT CANNOT BE PERSISTED. With writes
//    exhausted, the measured behaviour of the naive design was not "we lose
//    precision", it was INVERTED: each fresh isolate read an absent counter as
//    0, granted itself the full 4,000,000, and replayed the runaway to
//    8,003,600 rows at one isolate and 32,014,400 at four, against a 5,000,000
//    platform cap. The 429 read like protection while the outage arrived anyway.
//
//    So this module watches whether the counter is actually taking its writes.
//    Every flush that does not advance the shared total — because the write was
//    rejected, or because the budget is spent and can never write again —
//    increments a stall counter. STALL_FLUSH_FAILURES consecutive failures and
//    the shared counter is declared untrustworthy, and the ceiling drops to
//    degradedLimit(limit) = limit / DEGRADED_DIVISOR. The divisor is the point:
//    sixteen isolates each spending a sixteenth of the ceiling still total
//    exactly the ceiling, so isolate turnover cannot breach the account cap even
//    when the counter has been unreadable since the first request.
//
//    Honest limits: degraded mode cannot see other isolates, so it bounds the
//    ACCOUNT only by bounding each isolate, and it assumes at most
//    DEGRADED_DIVISOLIVES concurrent isolates. It is still the safe direction —
//    the failure mode is a loud, reversible 429, never an overrun. And the
//    trigger is per-isolate: a light-traffic isolate that never reaches a flush
//    never learns the counter is dead, which is harmless because it is also not
//    spending anything.
//
// A precise meter would need a Durable Object counter. That is not worth a new
// migration class on the incident path; this guard's job is "never reach 5M",
// and it now degrades toward that rather than away from it.
// ---------------------------------------------------------------------------

import { getShardDirectory } from './kv.js';

/** KV key prefix for the per-day read counter. */
export const D1_USAGE_PREFIX = 'd1-usage:';

/**
 * Rows/day the bridge will spend before it starts refusing. 4,000,000 leaves
 * ~1M of the platform's 5,000,000 free for cross-isolate undercount, for reads
 * made through other D1 entry points on this account, and for the margin
 * between "counter says" and "Cloudflare says".
 */
export const DEFAULT_DAILY_READ_LIMIT = 4_000_000;

/** How long an isolate reuses its cached KV read. Bounds KV reads, not correctness. */
export const STALE_MS = 5_000;

/**
 * Backstop flush interval for quiet days, in ms. Long on purpose: it only fires
 * when the rows trigger has not, i.e. when `pending` is small, so the staleness
 * it costs is small. It draws from the same DAILY_FLUSH_BUDGET as the rows
 * trigger, so this caps writes rather than creating them.
 */
export const SYNC_MS = 30 * 60_000;

/**
 * KV writes/day one isolate may spend flushing the counter. The free tier
 * allows 1,000/day for the whole account; at the ~4 isolates this account runs
 * that is 800, leaving room for the digest cursor. Exhausting the budget is
 * safe — the guard notices the counter has stalled and drops its own ceiling —
 * but it costs cross-isolate accuracy, which is what syncRows() spends.
 */
export const DAILY_FLUSH_BUDGET = 200;

/** Consecutive flushes that must fail to persist before the counter is distrusted. */
export const STALL_FLUSH_FAILURES = 3;

/**
 * Floor on the flush size, in rows. Below this a flush is not worth a KV write
 * whatever the ceiling says — the loss window it protects against is
 * proportional to the slice, and a tight ceiling makes each slice small in
 * absolute terms already. Without the floor, an operator running a deliberately
 * low limit would flush on nearly every request and burn the whole daily write
 * budget in a few thousand rows.
 */
export const MIN_SYNC_ROWS = 20_000;

/**
 * How many slices of the ceiling a degraded isolate may spend. Sixteen isolates
 * each spending a sixteenth still total exactly the ceiling, which is what makes
 * the degraded mode safe against isolate turnover rather than merely cautious.
 */
export const DEGRADED_DIVISOR = 16;

/** KV key for one UTC day's read total. */
export function dailyReadKey(at: Date = new Date()): string {
  return D1_USAGE_PREFIX + 'rows-read:' + at.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight — the cap resets then. */
export function secondsUntilUtcMidnight(at: Date = new Date()): number {
  return Math.max(1, Math.ceil((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1) - at.getTime()) / 1000));
}

/**
 * The configured ceiling, or Infinity when disabled.
 *
 * D1_DAILY_READ_LIMIT unset/empty → DEFAULT_DAILY_READ_LIMIT. `0`, `off`,
 * `none`, or `false` disables the guard entirely (Infinity) — the escape
 * hatch for a deliberate, funded read-heavy run. Any other value must be a
 * positive integer; anything else is treated as "set it wrongly" and falls
 * back to the default rather than failing open silently.
 */
export function dailyReadLimit(raw: string | undefined = process.env.D1_DAILY_READ_LIMIT): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_DAILY_READ_LIMIT;
  if (/^(0|off|none|false|disabled)$/i.test(value)) return Infinity;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_READ_LIMIT;
}

/**
 * Rows between flushes — the slice of the ceiling that one KV write is
 * responsible for. This is also the cross-isolate loss window: whatever is
 * still pending when a concurrent isolate writes is what two racing flushes
 * can lose between them. Derived so that DAILY_FLUSH_BUDGET writes cover the
 * whole ceiling exactly once, floored at MIN_SYNC_ROWS so a deliberately tight
 * ceiling spends fewer writes rather than more.
 */
export function syncRows(limit: number = dailyReadLimit()): number {
  if (!Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER;
  return Math.max(MIN_SYNC_ROWS, Math.ceil(limit / DAILY_FLUSH_BUDGET));
}

/** Rows/day one isolate may spend once the shared counter can no longer be persisted. */
export function degradedLimit(limit: number = dailyReadLimit()): number {
  if (!Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(limit / DEGRADED_DIVISOR));
}

export interface DailyReadState {
  /** Rows spent on the bridge today as this isolate can best know it. */
  used: number;
  /** The ceiling actually being enforced — `degradedLimit()` when `degraded`. */
  limit: number;
  /** False once `used` has reached `limit`. */
  allowed: boolean;
  /** True when the shared counter stopped taking this isolate's writes, so `limit` is the reduced one. */
  degraded: boolean;
}

/** Per-isolate view of today's counter. Reset only by the module (tests). */
interface Cached {
  day: string;
  /**
   * What the shared counter last said: this isolate's already-flushed rows plus
   * everyone else's. Never lowers `pending`, which is what keeps the local
   * total honest when the counter is stale or absent.
   */
  loaded: number;
  loadedAt: number;
  /** This isolate's rows that the shared counter has not taken yet. */
  pending: number;
  /**
   * When this isolate last touched KV — read OR write. Seeding it on the load
   * is what stops the first spend of every cold isolate from forcing a write.
   */
  syncedAt: number;
  /** KV writes this isolate has spent today. Hard stop at DAILY_FLUSH_BUDGET. */
  flushes: number;
  /** Consecutive flushes that failed to advance the shared counter. */
  stalled: number;
}

let cache: Cached | undefined;
let inFlight: Promise<void> | undefined;

/** Total this isolate believes is spent: the counter plus what it has not yet flushed. */
export function localTotal(): number {
  if (!cache) return 0;
  return cache.loaded + cache.pending;
}

/** KV writes this isolate has spent today, and consecutive failed flushes (tests assert both). */
export function budgetUsage(): { flushes: number; stalled: number } {
  return { flushes: cache?.flushes ?? 0, stalled: cache?.stalled ?? 0 };
}

/** Test hook — drop the per-isolate cache. */
export function resetReadBudgetCache(): void {
  cache = undefined;
  inFlight = undefined;
}

/** Fresh per-isolate state for a UTC day. */
function blank(day: string, now: number): Cached {
  return { day, loaded: 0, loadedAt: now, pending: 0, syncedAt: now, flushes: 0, stalled: 0 };
}

/**
 * Read today's counter out of KV. Missing, unparseable, and negative values
 * all read as 0: the guard's failure mode must be "we under-count and let a
 * little traffic through", never "we throw on the money path". KV being absent
 * entirely (runtimes without the binding) returns 0 for the same reason.
 *
 * Returning 0 is safe precisely because `pending` is tracked separately: a
 * counter that reads 0 does not erase the rows this isolate has already spent,
 * and a counter that stops advancing is what trips degraded mode.
 */
async function readKvTotal(day: string): Promise<number> {
  const kv = getShardDirectory();
  if (!kv) return 0;
  try {
    const raw = await kv.get(D1_USAGE_PREFIX + 'rows-read:' + day);
    const n = Number(raw ?? '');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Load KV's total into the per-isolate cache, or reuse a fresh load. */
async function load(now: number, day: string): Promise<Cached> {
  if (cache && cache.day === day && now - cache.loadedAt < STALE_MS) return cache;
  // Collapse concurrent cold loads in this isolate onto one KV read.
  if (!inFlight) {
    inFlight = readKvTotal(day).then((total) => {
      if (cache && cache.day === day) {
        // A concurrent record() already seeded this isolate — keep its pending.
        const at = Date.now();
        cache = { ...cache, loaded: Math.max(total, cache.loaded), loadedAt: at, syncedAt: at };
      } else {
        cache = { ...blank(day, Date.now()), loaded: total };
      }
    }).finally(() => {
      inFlight = undefined;
    });
  }
  await inFlight;
  // load() never leaves the cache empty: the read resolves into it either way.
  return cache ?? blank(day, now);
}

/**
 * May this isolate spend more D1 rows today? Call BEFORE executing a batch.
 *
 * Load errors are swallowed into the same counted-but-untrusted behaviour as a
 * missing counter, so an outage in the accounting path cannot take the bridge
 * (and its money paths) down with it.
 */
export async function guardDailyReads(at: Date = new Date()): Promise<DailyReadState> {
  const limit = dailyReadLimit();
  if (limit === Infinity) return { used: 0, limit, allowed: true, degraded: false };
  const day = at.toISOString().slice(0, 10);
  const now = at.getTime();
  let state: Cached;
  try {
    state = await load(now, day);
  } catch {
    state = cache ?? blank(day, now);
  }
  // Day rollover without a fresh load (isolate idle across midnight): the old
  // day's key is meaningless now, so start the new day from this isolate's own
  // pending rows rather than carrying yesterday's total into today.
  if (state.day !== day) state = cache = blank(day, now);
  const used = state.loaded + state.pending;
  const degraded = state.stalled >= STALL_FLUSH_FAILURES;
  const effective = degraded ? Math.min(limit, degradedLimit(limit)) : limit;
  return { used, limit: effective, allowed: used < effective, degraded };
}

/**
 * Record rows the bridge just read. Call AFTER a batch settles, including on
 * the failure path — a batch that errored may still have been metered.
 *
 * Accounting and the flush trigger are applied SYNCHRONOUSLY, before this
 * returns, so enforcement is correct even if the returned promise is never
 * awaited. The promise carries only the KV write: callers should pin it with
 * ctx.waitUntil (see src/cf/internal.ts) rather than hold the response on it.
 * It never rejects.
 */
export function recordDailyReads(reads: number, at: Date = new Date()): Promise<void> {
  const rows = Number.isFinite(reads) && reads > 0 ? Math.floor(reads) : 0;
  if (rows === 0 || dailyReadLimit() === Infinity) return Promise.resolve();
  const day = at.toISOString().slice(0, 10);
  const now = at.getTime();
  if (!cache || cache.day !== day) cache = blank(day, now);
  cache.pending += rows;
  if (now - cache.syncedAt < SYNC_MS && cache.pending < syncRows()) return Promise.resolve();
  return flush(now, day);
}

/**
 * Persist the counter to KV. Read-then-write, last write wins: two isolates
 * syncing at once can lose one window's attribution, which syncRows() bounds
 * (it is the pending count at flush time) and which the 20% margin in
 * DEFAULT_DAILY_READ_LIMIT absorbs on top. Never rejects.
 *
 * Refuses to write once DAILY_FLUSH_BUDGET is spent for the day. That is the
 * point, not a bug: it stops this module from being the thing that burns the
 * account's shared 1,000 writes/day, and the resulting stalled counter is what
 * trips degraded mode on the next guard check.
 */
async function flush(now: number, day: string): Promise<void> {
  const current = cache;
  if (!current || current.day !== day || current.pending <= 0) return;
  const kv = getShardDirectory();
  // Budget spent, or no binding to persist to: keep the rows pending. They stay
  // counted, so this isolate's ceiling is exact, and the stall it just recorded
  // drops it to the degraded ceiling once the failures add up.
  if (!kv || current.flushes >= DAILY_FLUSH_BUDGET) {
    current.syncedAt = now;
    current.stalled += 1;
    return;
  }
  // Count the write and mark synced BEFORE the await, so concurrent record()
  // calls cannot both flush the same window and a rejected write still costs
  // its budget slot.
  const batch = current.pending;
  current.flushes += 1;
  current.syncedAt = now;
  try {
    const stored = await readKvTotal(day);
    const total = Math.max(stored, current.loaded) + batch;
    await kv.put(dailyReadKey(new Date(now)), String(total));
    current.loaded = total;
    current.loadedAt = Date.now();
    // Rows that arrived during the await were never in `batch`; they stay
    // pending rather than being marked flushed.
    current.pending -= batch;
    current.stalled = 0;
  } catch {
    current.stalled += 1;
  }
}
