// ---------------------------------------------------------------------------
// Consecutive failure tracking (DB-backed, per workspace)
//
// MCP servers spawned by Claude Code / OpenCode are short-lived processes.
// An in-memory Map would reset on every tool call. We persist counts in
// Workspace.failureCountsJson as { "<backendId>": { count, lastAt, hard? } }.
// `hard` marks an account-level failure that cannot fix itself inside the
// window (an exhausted OpenRouter balance answers 402 forever); today only the
// OpenRouter balance 402 sets it. It is what parks the backend in the penalty
// box instead of just counting toward the fallback threshold (SLA-460).
// Rows written before this flag existed have no `hard` and keep behaving
// exactly as before.
//
// Split out of src/analysis/index.ts and given an explicit column dependency
// rather than reaching for the process-wide `db` proxy. Every bit of state here
// lives in that one JSON column, so the only way to pin any of it is to write a
// real row and read it back through a fresh client — and a test that went
// through `db` could not get one, because suites like src/lib/recreate-dedupe
// replace '../db.js' with mock.module for the whole `bun test` process. The
// Prisma calls stay in index.ts; this module only owns the JSON.
// ---------------------------------------------------------------------------

export const MAX_FAILURES_BEFORE_FALLBACK = 2;
export const FAILURE_TTL_MS = 1000 * 60 * 60; // a "consecutive" failure window — older counts decay

export interface FailureEntry {
  count: number;
  lastAt: number;
  /** Account-level failure: park the backend now, don't re-call it to confirm. */
  hard?: true;
}

export type FailureMap = Record<string, FailureEntry>;

/**
 * The one column this bookkeeping owns. Read returns the raw string so a
 * caller can see what is actually persisted; null means "no row / nothing
 * stored", which reads as an empty history.
 */
export interface FailureCountsColumn {
  read(workspaceId: string): Promise<string | null>;
  write(workspaceId: string, json: string): Promise<void>;
}

export async function loadFailureMap(col: FailureCountsColumn, workspaceId: string): Promise<FailureMap> {
  const raw = await col.read(workspaceId);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Decay: drop entries older than FAILURE_TTL_MS so a transient outage
    // 1h ago doesn't keep us in fallback mode forever — and so an hour-old
    // penalty box lets itself out instead of needing someone to clear it.
    const cutoff = Date.now() - FAILURE_TTL_MS;
    const out: FailureMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const entry = v as FailureEntry;
      if (entry.lastAt >= cutoff) out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveFailureMap(col: FailureCountsColumn, workspaceId: string, map: FailureMap): Promise<void> {
  await col.write(workspaceId, JSON.stringify(map));
}

/**
 * `hard` failures jump straight to the penalty-box threshold instead of
 * counting one by one: the same answer will come back, so there is nothing to
 * be gained from spending a second paid call to reach the same count. A later
 * transient failure on the same backend drops the flag, since it means the
 * backend is answering again.
 */
export async function recordFailure(
  col: FailureCountsColumn,
  workspaceId: string,
  backendId: string,
  hard = false,
): Promise<number> {
  const map = await loadFailureMap(col, workspaceId);
  const cur = map[backendId]?.count ?? 0;
  const newCount = hard ? Math.max(cur, MAX_FAILURES_BEFORE_FALLBACK) : cur + 1;
  map[backendId] = hard
    ? { count: newCount, lastAt: Date.now(), hard: true }
    : { count: newCount, lastAt: Date.now() };
  await saveFailureMap(col, workspaceId, map);
  return newCount;
}

/**
 * Clear ONE backend's streak — the backend that just succeeded, and nothing
 * else. `count` means "this backend failed N times in a row", so only that
 * backend's own success is evidence its streak ended; another backend
 * succeeding says nothing about it.
 *
 * This used to clear the whole map. Under SLA-460's penalty box that meant one
 * successful `gemini-native` analysis unparked `openrouter-video` while its
 * balance was still $0, so the next video paid one 402 to re-park it — the flap
 * the park exists to stop. The same over-reach reset a *count*: a `gemini-text`
 * fallback succeeding cleared the primary's two-strike record, putting the
 * workspace straight back on the backend that had just failed twice.
 *
 * Two consequences, both deliberate and both bounded by FAILURE_TTL_MS:
 *   - A workspace that flipped to its fallback stays there until the window
 *     decays or the backend itself succeeds (a config change, or an explicit
 *     forceBackend). A working fallback no longer earns the primary a free
 *     retry, which is the point: the retry is what cost the money.
 *   - The write is unconditional, so a success also compacts entries that have
 *     already decayed past the window instead of leaving them in the column
 *     forever. Same number of writes as the old whole-map clear, one narrower.
 */
export async function recordSuccess(col: FailureCountsColumn, workspaceId: string, backendId: string): Promise<void> {
  const map = await loadFailureMap(col, workspaceId);
  delete map[backendId];
  await saveFailureMap(col, workspaceId, map);
}