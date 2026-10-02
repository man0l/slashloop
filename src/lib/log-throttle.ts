// ---------------------------------------------------------------------------
// Throttled log lines — say it once, then say how many times you said nothing.
//
// A worker sweep that hits a dependency's rate limit every single pass is not
// 12 pieces of news, it is one condition. Logging the same warning on every
// pass buries every other line in the log and trains the reader to skip the
// prefix. SLA-317's smoke test caught this live: while a fallback backlog was
// draining, the maintenance worker emitted
//
//   [jobs] fallback reconcile throttled by queue-api after 0 publish(es);
//   24 row(s) still parked
//
// on every 5-minute sweep of all three containers, indefinitely, because the
// queue-api publish limiter is a per-kind+workspace 10/minute budget: the
// condition is self-healing (the rows are still selected by the next sweep)
// and yet it filled the log with a line that never changed.
//
// The shape that fixes it:
//
//   * the FIRST occurrence of a key is emitted immediately — the onset of a
//     new condition is the one thing that must never be lost
//   * occurrences inside the window are folded into a counter, not emitted
//   * the next occurrence after the window emits ONCE and carries
//     `folded` — the count of sweeps that were deliberately silenced — so the
//     operator still sees the true rate and nothing is silently dropped
//
// Window state is per-process and per-key, which is the right granularity:
// the VPS runs one worker process per container, and a fold count that
// accumulated across containers would overstate what any single log reader
// saw. `now` is injectable so the behaviour is unit-tested without sleeping.
// ---------------------------------------------------------------------------

export interface ThrottleOptions {
  /** Minimum wall-clock gap between two emitted lines for the same key. */
  everyMs: number;
  now?: () => number;
}

export interface Throttle {
  /**
   * Message to log for this occurrence, or null when it is inside the window
   * and should be folded into the next one. `folded` is the number of earlier
   * occurrences that were silenced since the last emitted line (0 on the first
   * occurrence, so callers can append a count only when there is one).
   *
   * `build` is called ONLY when the line is actually emitted, so a suppressed
   * occurrence costs no string formatting.
   */
  take(key: string, build: (folded: number) => string): string | null;
  /** Occurrences silenced since the last emitted line for `key`. Diagnostics/tests. */
  folded(key: string): number;
  /** Drop all state for `key`, or for every key when `key` is omitted. */
  reset(key?: string): void;
}

export function createThrottle(opts: ThrottleOptions): Throttle {
  const everyMs = Number.isFinite(opts.everyMs) && opts.everyMs > 0 ? opts.everyMs : 0;
  const now = opts.now ?? Date.now;
  const lastEmit = new Map<string, number>();
  const folded = new Map<string, number>();

  return {
    take(key: string, build: (n: number) => string): string | null {
      const at = now();
      const last = lastEmit.get(key);
      // No prior line, or the window has elapsed: emit and remember. everyMs
      // of 0 disables throttling entirely (every occurrence emits, folded
      // always 0) which keeps a caller from silently losing a line.
      if (last === undefined || everyMs === 0 || at - last >= everyMs) {
        const n = folded.get(key) ?? 0;
        lastEmit.set(key, at);
        folded.set(key, 0);
        return build(n);
      }
      folded.set(key, (folded.get(key) ?? 0) + 1);
      return null;
    },
    folded(key: string): number {
      return folded.get(key) ?? 0;
    },
    reset(key?: string): void {
      if (key === undefined) {
        lastEmit.clear();
        folded.clear();
      } else {
        lastEmit.delete(key);
        folded.delete(key);
      }
    },
  };
}

/** " (+12 folded)" — appended only when something was actually silenced. */
export function foldedSuffix(n: number): string {
  return n > 0 ? ` (+${n} folded)` : '';
}
