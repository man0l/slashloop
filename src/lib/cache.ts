// ---------------------------------------------------------------------------
// Per-process cache-aside with singleflight, for hot Workspace-scoped reads.
//
// Two wins in one helper:
//
//   1. TTL cache: repeated reads (page reloads, polls, second tabs, MCP +
//      site side by side) skip the DB chain for tens of seconds. Staleness
//      is bounded by the per-call TTL; mutations already invalidate
//      client-side via react-query, so the server TTL only governs
//      cross-tab/cross-client skew.
//   2. Singleflight: concurrent identical in-flight fills share ONE promise.
//      Probe bursts showed 10–30x duplicate concurrent GETs; without this
//      each one runs the full query chain, and overlapping engine use is
//      what wedges D1 isolates. Collapsing them removes that pressure with
//      zero staleness for the waiters.
//
// Rules (do not bend these):
//   - Workspace-scoped keys only — never share entries across workspaces.
//   - Never cache money (credits/billing), queue operations (claims, leases,
//     jobs), auth, or anything whose correctness needs read-your-write.
//   - Fail-open: cache bookkeeping never throws; a fill error propagates to
//     the caller and is NOT cached.
//   - Bounded: MAX_ENTRIES with drop-oldest; short TTLs turn everything over.
//
// Memory-only (per isolate / per VPS process). No KV, no bindings, no
// migration. Cross-isolate duplication is accepted — the TTLs are short and
// the expensive part (duplicate concurrent fills) is already collapsed per
// isolate by the singleflight.
// ---------------------------------------------------------------------------

/** Most entries retained. Gallery payloads are the largest (~100KB+). */
const MAX_ENTRIES = 100;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Stable key builder. Callers must include the workspace id. */
export function cacheKey(parts: Array<string | number | boolean>): string {
  return parts.map((p) => String(p)).join('|');
}

function evictIfNeeded(): void {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  // Expired first, then oldest-inserted (Map preserves insertion order).
  for (const [k, e] of store) {
    if (e.expiresAt <= now) store.delete(k);
    if (store.size < MAX_ENTRIES) return;
  }
  const oldest = store.keys().next();
  if (!oldest.done) store.delete(oldest.value);
}

/**
 * Return the cached value when fresh, else run `fill` exactly once even
 * under concurrent identical calls. Errors from `fill` propagate and are
 * never cached.
 */
export async function getOrFill<T>(key: string, ttlMs: number, fill: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  if (hit) store.delete(key);

  const ongoing = inflight.get(key);
  if (ongoing) return ongoing as Promise<T>;

  const run = (async () => {
    try {
      const value = await fill();
      evictIfNeeded();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/** Drop entries by exact key or `prefix|` prefix (targeted invalidation). */
export function invalidateCache(keyOrPrefix: string): number {
  let dropped = 0;
  const prefix = keyOrPrefix.endsWith('|') ? keyOrPrefix : `${keyOrPrefix}|`;
  for (const k of [...store.keys()]) {
    if (k === keyOrPrefix || k.startsWith(prefix)) {
      store.delete(k);
      dropped++;
    }
  }
  return dropped;
}

/** Test seam: clear everything. */
export function clearCache(): void {
  store.clear();
  inflight.clear();
}

/** Test seam: current entry count. */
export function cacheSize(): number {
  return store.size;
}
