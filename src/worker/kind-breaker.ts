// ---------------------------------------------------------------------------
// Per-kind circuit breaker for the VPS worker loop.
//
// A provider outage (proxy down, Apify cap, Gemini quota) fails every job of
// the affected kind identically. Without a breaker each failure spends 3
// claim→fail cycles (claim UPDATE + failJob UPDATE + terminal refund rows),
// and the next enqueue starts the burn again. The breaker parks a kind after
// N consecutive failures so failing work waits out the outage instead of
// spending D1 rows proving it is still down.
//
// In-memory per container by design: 3 containers learn independently, and a
// restart clears the state (fail-closed would need persistence and risks
// parking work forever on a stale flag). Requeued/yielded jobs ("never
// started") are neutral — only real failures count, only real successes reset.
// ---------------------------------------------------------------------------

export interface KindBreakerOptions {
  /** Consecutive failures before a kind parks (default 5). */
  threshold?: number;
  /** How long a parked kind is excluded from claims (default 5 min). */
  cooldownMs?: number;
  /** Test seam (default Date.now). */
  now?: () => number;
}

export interface KindBreaker {
  /** Record one finished job: true = success (resets), false = failure. */
  record(kind: string, ok: boolean): void;
  /** True while the kind is parked. Expired parks clear lazily here. */
  isOpen(kind: string): boolean;
  /** Kinds still claimable right now. */
  filterKinds(kinds: string[]): string[];
}

export function createKindBreaker(opts: KindBreakerOptions = {}): KindBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  // Consecutive-failure count per kind, and park-expiry per kind.
  const failures = new Map<string, number>();
  const parkedUntil = new Map<string, number>();

  function isOpen(kind: string): boolean {
    const until = parkedUntil.get(kind);
    if (until === undefined) return false;
    if (now() >= until) {
      // Half-open: let one claim through; record() decides from its outcome.
      parkedUntil.delete(kind);
      failures.delete(kind);
      return false;
    }
    return true;
  }

  return {
    record(kind: string, ok: boolean): void {
      if (ok) {
        failures.delete(kind);
        parkedUntil.delete(kind);
        return;
      }
      const n = (failures.get(kind) ?? 0) + 1;
      if (n >= threshold) {
        parkedUntil.set(kind, now() + cooldownMs);
        failures.delete(kind);
      } else {
        failures.set(kind, n);
      }
    },

    isOpen,

    filterKinds(kinds: string[]): string[] {
      return kinds.filter((k) => !isOpen(k));
    },
  };
}
