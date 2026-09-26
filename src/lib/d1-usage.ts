// ---------------------------------------------------------------------------
// D1 usage attribution — rows_read / rows_written counters.
//
// Every D1 statement on the VPS worker flows through one of two choke points,
// both of which feed this module:
//   • rawBatch (src/store.ts d1HttpRawExecutor — claims, sweeps, credits,
//     experiment saves — including the /internal/raw-batch bridge, whose
//     response carries the binding-side meta back)
//   • Prisma-over-D1-HTTP (fetch wrapper installed by initStoreD1Http —
//     db.mediaJob.update, db.video.create, …)
//
// Runtimes without D1-over-HTTP never record: totals stay 0. Never throws —
// observability must not break the worker loop. Snapshot/delta lets the
// worker loop attribute usage per job and per experiment tick so the D1
// write budget can be ranked by feature instead of guessed at.
// ---------------------------------------------------------------------------

export interface D1UsageDelta {
  reads: number;
  writes: number;
  /** Statements executed (a batch counts each member statement). */
  queries: number;
}

let totalReads = 0;
let totalWrites = 0;
let totalQueries = 0;

/** Add one statement's (or batch's) meta to the process totals. */
export function recordD1Usage(reads: number, writes: number, queries = 1): void {
  try {
    if (Number.isFinite(reads) && reads > 0) totalReads += Math.floor(reads);
    if (Number.isFinite(writes) && writes > 0) totalWrites += Math.floor(writes);
    if (Number.isFinite(queries) && queries > 0) totalQueries += Math.floor(queries);
  } catch {
    // Never break callers.
  }
}

/** Capture the current totals; pass to deltaD1Usage() after the work. */
export function snapshotD1Usage(): D1UsageDelta {
  return { reads: totalReads, writes: totalWrites, queries: totalQueries };
}

/** Usage accumulated since the snapshot. */
export function deltaD1Usage(snap: D1UsageDelta): D1UsageDelta {
  const now = snapshotD1Usage();
  return {
    reads: Math.max(0, now.reads - snap.reads),
    writes: Math.max(0, now.writes - snap.writes),
    queries: Math.max(0, now.queries - snap.queries),
  };
}

/** Process lifetime totals (diagnostics). */
export function totalD1Usage(): D1UsageDelta {
  return snapshotD1Usage();
}

/** Summarize a delta for log lines — empty string when nothing was spent. */
export function formatD1Usage(d: D1UsageDelta): string {
  if (d.writes === 0 && d.reads === 0) return '';
  return ` d1+w${d.writes}/r${d.reads}/q${d.queries}`;
}

// ---------------------------------------------------------------------------
// Binding-side stash for the /internal/raw-batch bridge.
//
// d1BindingRawExecutor (Worker side) records each batch here; the endpoint
// (src/cf/internal.ts) takes it right after rawBatch() and reports it back to
// the VPS caller. Per-isolate best-effort: concurrent batches may interleave,
// but the values only feed attribution, never correctness or billing.
// ---------------------------------------------------------------------------

let batchReads = 0;
let batchWrites = 0;

/** Stash one binding batch's meta (Worker side only). */
export function recordBatchUsage(reads: number, writes: number): void {
  try {
    batchReads = Number.isFinite(reads) && reads > 0 ? Math.floor(reads) : 0;
    batchWrites = Number.isFinite(writes) && writes > 0 ? Math.floor(writes) : 0;
  } catch {
    // Never break callers.
  }
}

/** Take (and reset) the stashed binding-side usage. */
export function takeBatchUsage(): { reads: number; writes: number } {
  const out = { reads: batchReads, writes: batchWrites };
  batchReads = 0;
  batchWrites = 0;
  return out;
}
