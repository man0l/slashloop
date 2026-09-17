// ---------------------------------------------------------------------------
// Per-process cache-aside for hot Workspace-scoped reads.
//
// TTL cache: repeated reads (page reloads, polls, second tabs, MCP + site
// side by side) skip the DB chain for tens of seconds. Staleness is bounded
// by the per-call TTL. Mutations MUST call invalidateCache — react-query
// only drops the browser cache; this Map lives in the Worker isolate, so a
// create-then-list without invalidation returns the pre-create payload
// (missing workspace / missing source) for the rest of the TTL.
//
// Do NOT singleflight (share an in-flight fill Promise across requests).
// On Cloudflare Workers a promise created during request A belongs to A's
// IoContext; if the client aborts A, workerd never settles it, and every
// later request that awaits that cached promise hangs until the isolate is
// recycled (better-auth#10315). Duplicate fills under concurrency are
// cheaper than a wedged isolate.
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
// migration. Cross-isolate duplication is accepted — the TTLs are short.
// ---------------------------------------------------------------------------

/** Most entries retained. Gallery payloads are the largest (~100KB+). */
const MAX_ENTRIES = 100;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** Bumped on every invalidate/clear so an in-flight fill cannot recache a stale snapshot. */
let cacheEpoch = 0;

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
 * Return the cached value when fresh, else run `fill`. Concurrent callers
 * each run fill — resolved values are cached, pending promises are not.
 * Errors from `fill` propagate and are never cached.
 */
export async function getOrFill<T>(key: string, ttlMs: number, fill: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  if (hit) store.delete(key);

  const epoch = cacheEpoch;
  const value = await fill();
  if (cacheEpoch !== epoch) {
    const after = store.get(key);
    if (after && after.expiresAt > Date.now()) return after.value as T;
    return value;
  }
  const raced = store.get(key);
  if (raced && raced.expiresAt > Date.now()) return raced.value as T;
  evictIfNeeded();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Drop entries by exact key or `prefix|` prefix (targeted invalidation). */
export function invalidateCache(keyOrPrefix: string): number {
  cacheEpoch++;
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

/** Drop the per-user workspace switcher list. */
export function invalidateWorkspaceList(userId: string): void {
  invalidateCache(cacheKey(['workspaces', userId]));
}

/** Drop every workspace-scoped read cache (sources, gallery, studio). */
export function invalidateWorkspaceReads(workspaceId: string): void {
  for (const kind of ['sources', 'gallery', 'retro', 'benchmark', 'creator-preview']) {
    invalidateCache(cacheKey([kind, workspaceId]));
  }
}

/** Test seam: clear everything. */
export function clearCache(): void {
  cacheEpoch++;
  store.clear();
}

/** Test seam: current entry count. */
export function cacheSize(): number {
  return store.size;
}
