// Worker KV namespace accessors — the seam for binding-backed state.
//
// Bindings are objects, so copyEnvToProcessEnv (env.ts) skips them; Worker
// code that needs a KV registers it here from ensureStore() instead. Node
// runtimes (the Vercel function, the VPS worker) never call
// setShardDirectory — the accessor returns undefined there and callers
// degrade (the digest cron pages only when the binding is present).

let shardDirectory: KVNamespace | undefined;

/** Record the SHARD_DIRECTORY binding (Worker-side; see src/cf/env.ts). */
export function setShardDirectory(kv: KVNamespace | undefined): void {
  shardDirectory = kv;
}

/**
 * The SHARD_DIRECTORY binding — undefined on runtimes without KV. Today the
 * digest sweep cursor lives here; the shard router (src/store.ts) will use
 * the same namespace once SHARD_COUNT > 1.
 */
export function getShardDirectory(): KVNamespace | undefined {
  return shardDirectory;
}

// ---------------------------------------------------------------------------
// Digest sweep cursor
//
// The weekly digest pages due workspaces across invocations (api/cron/digest.ts)
// so each invocation stays under D1's 1000-query cap. State is one KV value:
// the index of the next workspace to process, under a key scoped to the
// Monday (UTC) of the run's week. Why this survives crashes:
//   • crash between "process page" and "write cursor" → the next invocation
//     re-processes ≤ DIGEST_PAGE_SIZE workspaces. Safe: each workspace's
//     payload is rebuilt and its lastDigestAt overwritten with the same
//     value; worst case a recipient gets two identical emails.
//   • stale cursor from an aborted run → benign: processed workspaces leave
//     the due list (lastDigestAt is persisted before emailing), so the index
//     re-sits on the next unprocessed workspace.
//   • a cursor from another week must never be replayed — the due list has
//     changed under it — hence the Monday-scoped key: a new week simply
//     starts at 0.
// ---------------------------------------------------------------------------

export const DIGEST_CURSOR_PREFIX = 'digest:cursor:';

/** KV key for the digest cursor: `digest:cursor:<monday YYYY-MM-DD UTC>`. */
export function digestCursorKey(at: Date = new Date()): string {
  const mondayMs = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() - ((at.getUTCDay() + 6) % 7),
  );
  return DIGEST_CURSOR_PREFIX + new Date(mondayMs).toISOString().slice(0, 10);
}

/**
 * The next due-workspace index to process. Anything non-numeric, negative,
 * or past the end of the current due list (the sweep wrapped, or the list
 * shrank since the cursor was written) restarts at 0.
 */
export function clampCursorIndex(raw: string | null, dueLength: number): number {
  const idx = Number(raw ?? '');
  if (!Number.isInteger(idx) || idx < 0 || idx >= dueLength) return 0;
  return idx;
}