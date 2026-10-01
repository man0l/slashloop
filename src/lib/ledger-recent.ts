// Index-friendly "recent CreditLedger rows" for get_usage.
//
// D1 read-budget: the original single query ordered the whole workspace slice
// with a CASE expression
//
//   ORDER BY CASE WHEN "createdAt" LIKE '20%' THEN "createdAt"
//                  WHEN "refId"    LIKE '20%' THEN "refId"
//                  ELSE "createdAt" END DESC
// LIMIT 20
//
// No index can serve a CASE over two columns, so SQLite read every
// CreditLedger row for the workspace and then sorted it in a temp B-tree.
// Measured on production (workspace with 17,332 ledger rows, 2026-10-01):
//
//   34,663 rows read, 35.8 ms   <- CASE ORDER BY
//       20 rows read,  0.8 ms   <- ORDER BY "createdAt" DESC
//
// get_usage is a customer-facing tool on a Workers Free D1 database, and the
// Free tier allows 5,000,000 rows read per DAY (docs/d1 limits). One get_usage
// call burning 34,663 rows means ~145 calls/day hits the cap and every D1
// query in the account then fails until midnight UTC. That is exactly the
// 2026-09-30 outage in docs/queue-phase0-baseline.md and the indiestack
// `D1_ERROR: ...exceeded D1's free tier daily row read limit` storm.
//
// The fix keeps the exact same result set by splitting the CASE into two
// index-ranged reads and merging in memory:
//
//   * rows written after the bind fix have the timestamp in `createdAt`
//     (schema order) -> "createdAt" DESC uses CreditLedger_workspaceId_createdAt_idx
//   * rows written by the buggy bind have the timestamp in `refId`
//     -> the refId range ['20','21') matches exactly the ISO timestamps, and
//        it is a bounded range on the UNIQUE index
//        CreditLedger_workspaceId_refId_key, so it is a seek, not a scan
//
// Both sides are LIMIT-ed to the same N the caller asked for, so the union is
// safe: a row that would have ranked in the global top N is necessarily in the
// top N of at least one of the two orderings.
//
// The range endpoints are intentionally the ASCII digits '2' and '2' + 1
// rather than a LIKE. `LIKE '20%'` cannot use an index (measured: 15,404 rows
// read for one workspace). An explicit range can.

import { isLedgerTimestamp, normalizeLedgerColumns, type LedgerEntry } from './credit-reconcile.js';

export interface RawLedgerRow {
  delta: number;
  reason: string;
  tool: string | null;
  balanceAfter: number;
  refId: string;
  createdAt: string;
}

/**
 * ISO-8601 timestamps the ledger stores all start with the year '20'. As an
 * explicit range this is `[ '20', '21' )` — a prefix match expressed in a form
 * SQLite can serve from CreditLedger_workspaceId_refId_key.
 */
const ISO_REF_LOW = '20';
const ISO_REF_HIGH = '21';

const RECENT_COLUMNS = '"delta", "reason", "tool", "balanceAfter", "refId", CAST("createdAt" AS TEXT) AS "createdAt"';

/**
 * The two raw reads `fetchRecentLedgerRows` issues. Exported so a test can
 * assert the SQL stays index-shaped (no CASE, no table-wide ORDER BY) and
 * assert the merge, without a live D1.
 */
export const RECENT_LEDGER_QUERIES = {
  /** Timestamp in createdAt (all rows written after the bind fix). */
  inCreatedAt: `
    SELECT ${RECENT_COLUMNS}
      FROM "CreditLedger"
     WHERE "workspaceId" = $1
       AND "createdAt" >= '2000-01-01'
     ORDER BY "createdAt" DESC
     LIMIT $2`,
  /** Timestamp in refId (rows written by the buggy bind — see credit-reconcile). */
  inRefId: `
    SELECT ${RECENT_COLUMNS}
      FROM "CreditLedger"
     WHERE "workspaceId" = $1
       AND "refId" >= '${ISO_REF_LOW}' AND "refId" < '${ISO_REF_HIGH}'
     ORDER BY "refId" DESC
     LIMIT $2`,
} as const;

function millis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Merge the two reads into the newest `take` rows by effective timestamp.
 *
 * `normalizeLedgerColumns` is applied per row first, so a swapped row is
 * scored by the timestamp that actually lives in `refId` — that is the whole
 * reason the two reads are split rather than just concatenated. The latest row
 * is what `creditsTotalEqualsLatestLedgerBalance` compares against, so the
 * ordering has to match what the single CASE query produced.
 */
export function mergeRecentLedgerRows(
  rows: readonly RawLedgerRow[],
  take: number,
): LedgerEntry[] {
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const row of rows) {
    const normalized = normalizeLedgerColumns(row);
    // The unique index is [workspaceId, refId], so refId alone identifies a row
    // within one workspace. Both reads return the same row for a swapped entry.
    const key = `${normalized.refId}|${normalized.delta}|${normalized.balanceAfter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  out.sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  return out.slice(0, take);
}

/**
 * Read the newest `take` CreditLedger rows for a workspace using only
 * index-served predicates. `query` is the caller's D1 handle; it is injected so
 * this stays testable and so the SQL above is the single source of truth.
 */
export async function fetchRecentLedgerRows(
  query: (sql: string, ...params: unknown[]) => Promise<RawLedgerRow[]>,
  workspaceId: string,
  take: number,
): Promise<LedgerEntry[]> {
  const [inCreatedAt, inRefId] = await Promise.all([
    query(RECENT_LEDGER_QUERIES.inCreatedAt, workspaceId, take),
    query(RECENT_LEDGER_QUERIES.inRefId, workspaceId, take),
  ]);
  return mergeRecentLedgerRows([...inCreatedAt, ...inRefId], take);
}

export { isLedgerTimestamp };
