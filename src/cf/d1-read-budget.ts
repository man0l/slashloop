// ---------------------------------------------------------------------------
// Daily row-read ceiling for the /internal/raw-batch bridge.
//
// Why this exists (2026-09-30, SLA-195): the account sits on D1's free tier,
// which caps an ACCOUNT at 5M rows read per UTC day. One runaway client — the
// VPS worker containers looping on rawBatch — spent 74.3M rows on that cap in
// twelve hours: 33,712 bridge requests, ~2,200 rows each, flat from 00:00Z to
// 11:00Z. The blast radius is the whole account, not the client: once the cap
// is reached every D1 read on EVERY database fails with Cloudflare error 7500
// until midnight UTC, so an unrelated read-only query in another product on
// the same account starts failing too.
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
// Consistency: deliberately SOFT. KV is eventually consistent and isolates are
// independent, so two isolates can each load total T and each write T + their
// own pending rows, losing one window's attribution. The cached read is reused
// for STALE_MS (5s) per isolate, so a runaway cannot turn into one KV read per
// request (KV free tier: 100k reads/day; the 2026-09-30 rate was 2,800/hour).
// Rows spent since that load are added locally and counted against the ceiling
// immediately, so the staleness costs at most 5s x request-rate x rows-per-
// request — about 11k rows at the 2026-09-30 rate, ~0.2% of the cap.
//
// ---------------------------------------------------------------------------
// SYNC_MS / SYNC_ROWS / MAX_DAILY_WRITES are BUDGET knobs, not accuracy knobs.
//
// They look like accuracy knobs — "flush more often, meter more precisely" —
// and changing them changes how many KV WRITES the account spends, which is the
// scarce resource. KV free tier: 1,000 writes/day, ACCOUNT-WIDE, shared with
// every other namespace on the account including the digest cursor.
//
//   • A minute-based floor is a tuning argument, not a bound. Replaying the
//     2026-09-30 runaway through a revision of this module that flushed every
//     SYNC_MS and nothing else measured 1,403 writes/day at ONE isolate
//     against the 1,000/day cap — over budget before the second isolate, and
//     linear in isolates on top.
//   • MAX_DAILY_WRITES is the bound instead. A per-isolate daily budget makes
//     the account-wide cost 50 x live isolates rather than 1,440 x isolates,
//     and it does not move when traffic does. After the budget is spent this
//     isolate stops paying for KV and runs local-only (see the degraded mode
//     below — local-only means a LOWER ceiling, not the same one).
//   • SYNC_ROWS still flushes early rather than waiting out SYNC_MS, so a busy
//     day keeps its window small until the write budget runs out. Raising it
//     would spend fewer writes and lose more rows; there is no setting that
//     gets both.
//
// The price of cheap writes is accuracy, and it is real. Cheap writes and
// cross-isolate accuracy are a TRADE, not a free win. KV's read-then-write
// loses whatever another isolate had pending, so the unflushed window is the
// loss: a naive "flush every 30 min / 1,000,000 rows" fix measured 48
// writes/day but ~1.5M rows of worst-case cross-isolate loss — 30.9% of the
// 5M cap, i.e. the entire headroom DEFAULT_DAILY_READ_LIMIT leaves. This
// module spends that budget on writes (the cap that actually took the account
// down) and keeps the window small where it still can. A precise meter would
// need a Durable Object counter; that is not worth a new migration class on the
// incident path for a guard whose job is "never reach 5M".
//
// DEFAULT_DAILY_READ_LIMIT is 4,000,000 against a 5,000,000 platform cap: that
// 20% margin is the budget for cross-isolate undercount plus the known-
// unmeasurable reads from OTHER D1 entry points on this account.
//
// ---------------------------------------------------------------------------
// Degraded mode fails toward a LOWER ceiling.
//
// Cloudflare does not queue KV writes past the account cap; it fails them. So
// the availability of the counter is load-bearing, and the guard has to get
// STRICTER when it goes away, not looser:
//
//   • When this isolate cannot read or persist the shared counter it keeps
//     counting rows locally against DEGRADED_LIMIT_FRACTION of the ceiling —
//     1,000,000 rows at the default instead of 4,000,000. Triggers: no KV
//     binding, the most recent load could not read the counter, a write
//     threw, or the daily write budget is spent.
//   • Degrading toward the full ceiling is what inverts the guard. Every
//     isolate reads 0 out of an unwritten key and grants itself the whole
//     limit, so the account spends the ceiling N times over. Measured on the
//     2026-09-30 replay with writes exhausted, that spent 8,003,600 rows at
//     one isolate and 32,014,400 at four, against the 5,000,000 platform cap
//     — roughly twice the ceiling, behind a 429 that looks like protection.
//     The same replay with the reduced ceiling stops at 1,001,000 and
//     4,004,000 (one batch of overshoot each).
//   • The bound that survives a KV-write outage is `live isolates x reduced
//     ceiling`, not `live isolates x limit`. Without shared state there is no
//     account-wide number, only a per-isolate one — which is the whole reason
//     the write budget above exists: to make the outage itself unlikely.
//   • A fresh isolate cannot know writes are dead until its own first flush
//     fails, so it runs at the full ceiling for at most one sync window
//     (SYNC_MS = 60s). At the 2026-09-30 rate that is ~100k rows, not
//     millions, and the next load drops it to the reduced ceiling.
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
 * Budget knob: the longest a spent row may stay unpersisted before a flush is
 * attempted. One flush per SYNC_MS per isolate is a WRITE RATE, and 1,440 of
 * them a day is over the 1,000/day account cap on its own — see MAX_DAILY_WRITES
 * for the actual bound.
 */
export const SYNC_MS = 60_000;

/**
 * Budget knob: flush early once this many rows are unpersisted. This is what
 * keeps the cross-isolate loss window small on the write path that is still
 * affordable; it is also what spends the budget fastest, and it does not raise
 * the daily ceiling on writes.
 */
export const SYNC_ROWS = 100_000;

/**
 * Budget knob, and the bound that makes the account cap unreachable by tuning:
 * KV writes ONE isolate will spend per UTC day. After that it stops writing,
 * drops to the reduced ceiling (see DEGRADED_LIMIT_FRACTION), and keeps
 * counting locally for the rest of the day.
 *
 * Account-wide cost is this times the number of live isolates, which is the
 * honest bound: 50 x 20 isolates exhausts the 1,000/day cap, so the write
 * budget makes an outage unlikely, not impossible. Past it the reduced ceiling
 * is what keeps the cap from being spent N times over.
 */
export const MAX_DAILY_WRITES = 50;

/**
 * Fraction of the ceiling an isolate falls back to when its counter cannot be
 * read or persisted. 1/4 turns "each isolate grants itself the full 4,000,000"
 * into "each isolate stops at 1,000,000", which is what keeps four degraded
 * isolates inside the 5,000,000 platform cap.
 */
export const DEGRADED_LIMIT_FRACTION = 0.25;

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
 * The ceiling to enforce when the counter cannot be read or persisted. Always
 * strictly below `limit` above 1 row, and never above the real limit: losing
 * shared accounting may only ever make this stricter.
 */
export function degradedDailyReadLimit(limit: number): number {
  if (limit === Infinity) return Infinity;
  if (limit <= 1) return limit;
  return Math.max(1, Math.floor(limit * DEGRADED_LIMIT_FRACTION));
}

export interface DailyReadState {
  /** Rows the account has spent on the bridge today, as this isolate sees it. */
  used: number;
  /** Infinity when the guard is disabled; the reduced ceiling when degraded. */
  limit: number;
  /** False once `used` has reached `limit`. */
  allowed: boolean;
  /** True when `limit` is the reduced ceiling (counter unavailable). */
  degraded: boolean;
}

/** Per-isolate view of today's counter. Reset only by the module (tests). */
interface Cached {
  day: string;
  /** KV's value at load time, before this isolate's pending rows. */
  loaded: number;
  loadedAt: number;
  /** Rows spent on this isolate since `loaded` was read. */
  pending: number;
  /**
   * When this isolate last touched KV — read OR write. Seeding it on the load
   * is what stops the first spend of every cold isolate from forcing a write.
   */
  syncedAt: number;
  /** KV writes this isolate has spent today. Capped at MAX_DAILY_WRITES. */
  writes: number;
  /**
   * Sticky for the day: writes are unavailable here (budget spent, or a write
   * threw). Cleared only by the day rolling over.
   */
  writeDegraded: boolean;
  /**
   * The most recent load could not read the shared counter. Re-derived on every
   * load, so a single blip stops degrading within STALE_MS while a dead KV does
   * not.
   */
  readDegraded: boolean;
}

let cache: Cached | undefined;
let inFlight: Promise<void> | undefined;
/** The flush currently persisting this isolate's rows, if any. */
let flushing: Promise<void> | undefined;

/** Total this isolate believes is spent: KV's number plus its own pending rows. */
export function localTotal(now = Date.now()): number {
  if (!cache) return 0;
  return cache.loaded + cache.pending;
}

/** Test hook — drop the per-isolate cache. */
export function resetReadBudgetCache(): void {
  cache = undefined;
  inFlight = undefined;
  flushing = undefined;
}

/** A fresh per-isolate cache for `day`, with nothing spent and nothing owed. */
function freshCache(day: string, now: number): Cached {
  return { day, loaded: 0, loadedAt: now, pending: 0, syncedAt: now, writes: 0, writeDegraded: false, readDegraded: false };
}

/** Shared counter read plus whether the read actually worked. */
interface KvTotal {
  total: number;
  ok: boolean;
}

/**
 * Read today's counter out of KV. Missing, unparseable, and negative values all
 * read as 0 with `ok: true` — a genuinely empty day is not a broken counter.
 * A missing binding or a throwing read reports `ok: false`, which is what puts
 * this isolate on the reduced ceiling: it is counting on its own memory alone.
 */
async function readKvTotal(day: string): Promise<KvTotal> {
  const kv = getShardDirectory();
  if (!kv) return { total: 0, ok: false };
  try {
    const raw = await kv.get(D1_USAGE_PREFIX + 'rows-read:' + day);
    const n = Number(raw ?? '');
    return { total: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, ok: true };
  } catch {
    return { total: 0, ok: false };
  }
}

/** Load KV's total into the per-isolate cache, or reuse a fresh load. */
async function load(now: number, day: string): Promise<Cached> {
  if (cache && cache.day === day && now - cache.loadedAt < STALE_MS) return cache;
  // Collapse concurrent cold loads in this isolate onto one KV read.
  if (!inFlight) {
    inFlight = readKvTotal(day).then(({ total, ok }) => {
      const at = Date.now();
      if (cache && cache.day === day) {
        // A concurrent record() already seeded this isolate — keep its pending,
        // keep the day sticky flags, and never lower what we already counted.
        cache = { ...cache, loaded: Math.max(total, cache.loaded), loadedAt: at, syncedAt: at, readDegraded: !ok };
      } else {
        cache = { ...freshCache(day, at), loaded: total, readDegraded: !ok };
      }
    }).finally(() => {
      inFlight = undefined;
    });
  }
  await inFlight;
  // load() never leaves the cache empty: the read resolves into it either way.
  return cache ?? freshCache(day, now);
}

/**
 * May this isolate spend more D1 rows today? Call BEFORE executing a batch.
 *
 * Load/refresh errors are swallowed into the same fail-closed-but-counted
 * behaviour as a missing counter, so an outage in the accounting path cannot
 * take the bridge (and its money paths) down with it — it can only make the
 * ceiling stricter.
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
    state = cache ?? freshCache(day, now);
    state.readDegraded = true;
  }
  // Day rollover without a fresh load (isolate idle across midnight): the old
  // day's key is meaningless now, so start the new day at this isolate's own
  // spend rather than carrying yesterday's total — or yesterday's write budget
  // — into today.
  if (state.day !== day) state = freshCache(day, now);
  // Losing shared accounting may only tighten the ceiling. See the header: the
  // full ceiling here is what spent 8M rows at one isolate in the replay.
  const degraded = state.readDegraded || state.writeDegraded || !getShardDirectory();
  const effective = degraded ? degradedDailyReadLimit(limit) : limit;
  const used = state.loaded + state.pending;
  return { used, limit: effective, allowed: used < effective, degraded };
}

/**
 * Record rows the bridge just read. Call AFTER a batch settles, including on
 * the failure path — a batch that errored may still have been metered.
 *
 * Counts locally before its first await, so a caller that does not await this
 * (the bridge pins it with waitUntil — a batch's response must not wait on a KV
 * write) has still counted the rows by the time it returns. Persistence to KV
 * is best-effort and never rejects.
 */
export async function recordDailyReads(reads: number, at: Date = new Date()): Promise<void> {
  const rows = Number.isFinite(reads) && reads > 0 ? Math.floor(reads) : 0;
  if (rows === 0 || dailyReadLimit() === Infinity) return;
  const day = at.toISOString().slice(0, 10);
  const now = at.getTime();
  if (!cache || cache.day !== day) cache = freshCache(day, now);
  cache.pending += rows;
  if (now - cache.syncedAt < SYNC_MS && cache.pending < SYNC_ROWS) return;
  await flush(now, day);
}

/**
 * Persist pending rows to KV. Read-then-write, last write wins: two isolates
 * syncing at once can lose one window's attribution, which the margin in
 * DEFAULT_DAILY_READ_LIMIT is sized to absorb. Never throws.
 */
async function flush(now: number, day: string): Promise<void> {
  const current = cache;
  if (!current || current.day !== day) return;
  const pending = current.pending;
  if (pending <= 0) return;
  // One flush at a time per isolate. Two overlapping flushes would each compute
  // `stored + their own pending` from the same base, and the one landing second
  // could overwrite a HIGHER total with a lower one — an isolate forgetting rows
  // it has already spent, which is precisely how a ceiling stops biting. Skipping
  // costs nothing now that writes are rationed: the rows stay pending and the
  // next recordDailyReads retries (pending is still over the thresholds).
  if (flushing) return;
  current.syncedAt = now;
  if (current.writes >= MAX_DAILY_WRITES) {
    // Write budget spent. Publishing anything more would take from the account-
    // wide 1,000/day cap this namespace shares with the digest cursor, so stop
    // trying. The rows stay in `pending` (still counted against the ceiling)
    // and this isolate now runs on the reduced ceiling, because from here its
    // spend is invisible to every other isolate.
    current.writeDegraded = true;
    return;
  }
  const kv = getShardDirectory();
  if (!kv) {
    // No binding: nothing to persist to. Keep the rows counted locally so the
    // reduced ceiling still bites within this isolate's lifetime.
    current.writeDegraded = true;
    return;
  }
  // Mark synced BEFORE the await so concurrent record() calls in this isolate
  // cannot both decide to flush the same pending window.
  current.pending = 0;
  current.writes += 1;
  const run = (async () => {
    try {
      const { total: stored } = await readKvTotal(day);
      const total = Math.max(stored, current.loaded) + pending;
      await kv.put(dailyReadKey(new Date(now)), String(total));
      // Monotonic: a slower/later flush may only ever raise what this isolate
      // believes it spent, never lower it.
      current.loaded = Math.max(current.loaded, total);
      current.loadedAt = Date.now();
    } catch {
      // Accounting is best-effort by design: give the rows back to `pending` so
      // this isolate keeps counting them even though the write failed, and drop
      // to the reduced ceiling — a write that failed means the platform's write
      // cap is spent, and past it the shared counter stops moving for everyone.
      current.pending += pending;
      current.writeDegraded = true;
    }
  })();
  flushing = run;
  try {
    await run;
  } finally {
    flushing = undefined;
  }
}