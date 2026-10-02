// get-usage reconciliation.
//
// Workspace.planCredits + packCredits is the customer wallet. CreditLedger is
// the append-only explanation of that wallet (one row per debit, refund, and
// grant). UsageLog is a different book: provider COGS in cents (Apify, Gemini).
// A credit debit does not write a UsageLog row, so credits.total cannot be
// checked against sum(UsageLog.costCents).
//
// Fixed-price MCP tools (create_brief and the same preauth shape) debit before
// the model call and write UsageLog only after the artifact is saved. A row
// that is still a lone `:preauth`, with no `:fail` / `:settle` / `:commit`
// sibling and no UsageLog in the following few minutes, is the SLA-166
// signature: the wallet moved and get-usage.recentLogs did not.
//
// ---------------------------------------------------------------------------
// The wallet invariant is checked over a WINDOW, not over the whole slice.
//
// `SELECT SUM("delta") ... WHERE "workspaceId" = ?` is a full scan of the
// workspace's ledger: 17,332 rows read per get_usage call on the largest
// production workspace (2026-10-02), against a 5,000,000 rows/day Workers Free
// cap. That single aggregate was ~99% of the tool's D1 cost and it cannot be
// paged or indexed — the sum has no index and the rows it needs are the ones
// no index range can name.
//
// It is also, on real data, the WRONG check. `sum(delta)` is not supposed to
// equal the wallet:
//
//   * `txSetPlan` (src/lib/credits.ts) writes `delta = updated.planCredits -
//     before.planCredits` — a plan CYCLE RESET is a new allotment, not an
//     increment of every credit ever spent. Resetting 3,000 -> 0 records
//     -3,000 while the customer had only spent part of it, and the running
//     total permanently stops matching the wallet.
//   * The experiments path (src/experiments/store.ts) splits one charge into a
//     plan row and a pack row, and deliberately writes a zero-delta row to
//     keep the split exact.
//
// Measured on production before this change: every one of the five workspaces
// with a non-trivial ledger reported `creditsTotalEqualsSumOfLedgerDeltas:
// false` while the wallet matched the newest `balanceAfter` exactly. The leg
// was paying 17,332 rows to report a discrepancy that was not there.
//
// What the invariant actually is: `balanceAfter` on each row is the wallet as
// of that write, so the wallet must equal the newest row's `balanceAfter`, and
// every row in the window except the oldest must have its predecessor balance
// present in the window. Both are computable from the bounded recent window
// get_usage already reads, at zero extra D1 cost, and both hold on every
// production workspace measured. A missing, duplicated, or hand-edited row
// breaks the second; so does a wallet that moved with no ledger row behind it.
//
// The honest limit, stated so the next person does not over-read this: a
// window check cannot see a row corrupted BEFORE the window. That is a
// deliberate trade — an unbounded scan on a customer-facing tool, on a shared
// 5M/day account cap, to find a corruption that has not been observed in any
// live workspace is the wrong place to spend the budget. `fullLedgerAudit`
// below is the escape hatch for when someone does need the whole slice.

export interface LedgerEntry {
  delta: number;
  reason: string;
  tool: string | null;
  balanceAfter: number;
  refId: string;
  createdAt: Date | string;
}

export interface UsageEntry {
  costCents: number;
  createdAt: Date | string;
}

/** Tools whose preauth is the final charge. Success does not write a second ledger row. */
export const FIXED_PRICE_PREAUTH_TOOLS = new Set([
  'create_brief',
  'generate_script',
  'generate_hook_variations',
  'suggest_sources',
  'discover_seeds',
]);

const SIBLING_SUFFIX = /:(preauth|fail|settle|commit)$/;

export interface WalletReconciliation {
  creditsTotal: number;
  /** Newest row's balanceAfter — the wallet as of the last ledger write. */
  latestLedgerBalance: number | null;
  /** The equality get-usage owes its caller. Free: the recent window has it. */
  creditsTotalEqualsLatestLedgerBalance: boolean;
  /**
   * Every consecutive pair inside the window satisfies
   * `row[n].balanceAfter === row[n-1].balanceAfter + row[n].delta`.
   * `null` when the window has fewer than two rows (nothing to chain).
   */
  ledgerChainIntact: boolean | null;
  /**
   * Rows whose predecessor balance is missing from the window — a deleted,
   * inserted, or hand-edited row. Empty when the window is intact. The oldest
   * row is never listed: its predecessor is legitimately outside the window.
   */
  ledgerChainBreaks: LedgerChainBreak[];
  /** Provider COGS for the requested period. Not the wallet. */
  usageLogCostCents: number;
  creditsTotalEqualsUsageLogCostCents: boolean;
  /** Lone fixed-price preauths in `ledgerRows` with no nearby UsageLog row. */
  chargedWithoutUsageLog: LedgerEntry[];
  /** True when nothing above reported a discrepancy. */
  ok: boolean;
  /**
   * Present only when the caller ran the opt-in whole-slice audit. Costs one
   * full scan of the workspace ledger, so it is never on the default path.
   */
  fullLedgerAudit?: FullLedgerAudit;
}

/** A row whose predecessor balance does not appear anywhere in the window. */
export interface LedgerChainBreak {
  refId: string;
  createdAt: string;
  /**
   * The balance this row's predecessor should have left behind
   * (`balanceAfter - delta`). Present in the window for an intact chain.
   */
  expectedBalanceAfter: number;
  actualBalanceAfter: number;
  /**
   * Always 0: this check establishes THAT a link is missing, not its size.
   * The wallet-vs-ledger comparison carries the magnitude.
   */
  drift: number;
}

export interface FullLedgerAudit {
  sumOfLedgerDeltas: number;
  rowCount: number;
  /** credits.total - sum(delta). Non-zero on a plan-cycle reset; see header. */
  driftFromWallet: number;
  rowsRead: number | null;
}

/** ISO-8601 timestamps the ledger stores. Idempotency keys do not match. */
const LEDGER_TIME = /^\d{4}-\d{2}-\d{2}T/;

export function isLedgerTimestamp(value: Date | string): boolean {
  const text = value instanceof Date ? value.toISOString() : value;
  return LEDGER_TIME.test(text);
}

/**
 * D1 debit/refund inserts used to bind the timestamp into `refId` and the
 * idempotency key into `createdAt`. Prisma then rejected `createdAt` as a
 * DateTime (the value `sla16-recreate-canary-grant:cf7b725d` is one of those
 * keys). Rows written after the bind fix already have the columns in schema
 * order. This swaps a row back in memory when only `refId` is a timestamp,
 * so get_usage can read both shapes. It does not write.
 */
export function normalizeLedgerColumns(row: LedgerEntry): LedgerEntry {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  const refId = String(row.refId);
  if (!isLedgerTimestamp(createdAt) && isLedgerTimestamp(refId)) {
    return { ...row, refId: createdAt, createdAt: refId };
  }
  return { ...row, refId, createdAt };
}

function millis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function opIdOf(refId: string): string {
  return refId.replace(SIBLING_SUFFIX, '');
}

export function chargedWithoutUsageLog(
  ledgerRows: LedgerEntry[],
  usageRows: UsageEntry[],
  windowMs = 5 * 60 * 1000,
): LedgerEntry[] {
  const closed = new Set<string>();
  for (const row of ledgerRows) {
    if (
      row.refId.endsWith(':fail')
      || row.refId.endsWith(':settle')
      || row.refId.endsWith(':commit')
      || row.reason === 'call_failed'
      || row.reason === 'fetch_failed'
      || row.reason === 'usage_settlement'
    ) {
      closed.add(opIdOf(row.refId));
    }
  }

  const flagged: LedgerEntry[] = [];
  for (const row of ledgerRows) {
    if (row.delta >= 0 || !row.refId.endsWith(':preauth')) continue;
    if (!row.tool || !FIXED_PRICE_PREAUTH_TOOLS.has(row.tool)) continue;
    const op = opIdOf(row.refId);
    if (closed.has(op)) continue;
    const t = millis(row.createdAt);
    const hasUsage = usageRows.some((usage) => {
      const at = millis(usage.createdAt);
      return at >= t - 1000 && at <= t + windowMs;
    });
    if (!hasUsage) flagged.push(row);
  }
  return flagged;
}

/**
 * Report rows whose predecessor balance is missing from the window.
 *
 * `balanceAfter` is the wallet as of that row's write, so a row's predecessor
 * is the row whose `balanceAfter` equals `this.balanceAfter - this.delta`. In
 * an intact window every row but the OLDEST has its predecessor in the window;
 * the oldest one's predecessor is legitimately outside it. Two or more
 * unanchored rows means a row was deleted, inserted, or a delta was edited.
 *
 * Why this is set-membership and not a walk over consecutive rows:
 * `createdAt` is stamped when the request is built, but the D1 rawBatch
 * commits later, so under concurrency the timestamp order is NOT the write
 * order. On production workspace b2967893 two debits 4ms apart stored
 * balanceAfter 274 and 282 in the opposite order to their createdAt, and a
 * consecutive-pair walk reported 6 phantom breaks on a healthy ledger. Two
 * debits landing in the same millisecond are routine, not corruption. Ordering
 * by `balanceAfter` instead does not fix it either — `balanceAfter` is not
 * monotonic across a window that mixes debits and refunds, and that ordering
 * reported phantom breaks too. Set membership asks the same question without
 * assuming an order the table does not store.
 *
 * Verified against production 2026-10-02: 0 false positives across all 9
 * workspaces with 2+ ledger rows, at take=20. It still fires on a deleted row,
 * a hand-edited delta, and the real 2-credit corruption in the 2026-09-01 rows
 * of workspace 63c754e4.
 */
export function findLedgerChainBreaks(ledgerRows: readonly LedgerEntry[]): LedgerChainBreak[] {
  const balances = new Set(ledgerRows.map((row) => row.balanceAfter));
  return ledgerRows
    .filter((row) => !balances.has(row.balanceAfter - row.delta))
    // The oldest row's predecessor is outside the window by construction, so
    // keep exactly one unanchored row: the one with the smallest createdAt.
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
    .slice(0, Math.max(0, countUnanchored(ledgerRows, balances) - 1))
    .map((row) => {
      const expected = row.balanceAfter - row.delta;
      return {
        refId: row.refId,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        expectedBalanceAfter: expected,
        actualBalanceAfter: row.balanceAfter,
        drift: 0,
      };
    });
}

function countUnanchored(rows: readonly LedgerEntry[], balances: Set<number>): number {
  let n = 0;
  for (const row of rows) if (!balances.has(row.balanceAfter - row.delta)) n++;
  return n;
}

export function reconcileWallet(input: {
  creditsTotal: number;
  latestLedgerBalance: number | null;
  usageLogCostCents: number;
  ledgerRows: readonly LedgerEntry[];
  usageRows: readonly UsageEntry[];
  fullLedgerAudit?: FullLedgerAudit;
}): WalletReconciliation {
  const { creditsTotal, latestLedgerBalance, usageLogCostCents } = input;
  const chainBreaks = findLedgerChainBreaks(input.ledgerRows);
  const ledgerChainIntact = input.ledgerRows.length < 2 ? null : chainBreaks.length === 0;
  const creditsTotalEqualsLatestLedgerBalance = latestLedgerBalance == null || creditsTotal === latestLedgerBalance;
  const charged = chargedWithoutUsageLog(input.ledgerRows as LedgerEntry[], input.usageRows as UsageEntry[]);

  return {
    creditsTotal,
    latestLedgerBalance,
    creditsTotalEqualsLatestLedgerBalance,
    ledgerChainIntact,
    ledgerChainBreaks: chainBreaks,
    usageLogCostCents,
    creditsTotalEqualsUsageLogCostCents: creditsTotal === usageLogCostCents,
    chargedWithoutUsageLog: charged,
    ok: creditsTotalEqualsLatestLedgerBalance
      && ledgerChainIntact !== false
      && charged.length === 0,
    ...(input.fullLedgerAudit ? { fullLedgerAudit: input.fullLedgerAudit } : {}),
  };
}
