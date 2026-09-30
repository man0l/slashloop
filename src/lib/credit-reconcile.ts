// get-usage reconciliation.
//
// Workspace.planCredits + packCredits is the customer wallet. CreditLedger is
// the append-only explanation of that wallet (one row per debit, refund, and
// grant). UsageLog is a different book: provider COGS in cents (Apify, Gemini).
// A credit debit does not write a UsageLog row, so credits.total cannot be
// checked against sum(UsageLog.costCents). The check that must hold is:
//
//   credits.total === sum(CreditLedger.delta) === latest CreditLedger.balanceAfter
//
// Fixed-price MCP tools (create_brief and the same preauth shape) debit before
// the model call and write UsageLog only after the artifact is saved. A row
// that is still a lone `:preauth`, with no `:fail` / `:settle` / `:commit`
// sibling and no UsageLog in the following few minutes, is the SLA-166
// signature: the wallet moved and get-usage.recentLogs did not.

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
  /** Sum of every CreditLedger.delta for the billing workspace. */
  sumOfLedgerDeltas: number;
  latestLedgerBalance: number | null;
  /** The equality get-usage owes its caller. */
  creditsTotalEqualsSumOfLedgerDeltas: boolean;
  creditsTotalEqualsLatestLedgerBalance: boolean;
  /** Provider COGS for the requested period. Not the wallet. */
  usageLogCostCents: number;
  creditsTotalEqualsUsageLogCostCents: boolean;
  /** Lone fixed-price preauths in `ledgerRows` with no nearby UsageLog row. */
  chargedWithoutUsageLog: LedgerEntry[];
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

export function reconcileWallet(input: {
  creditsTotal: number;
  sumOfLedgerDeltas: number;
  latestLedgerBalance: number | null;
  usageLogCostCents: number;
  ledgerRows: LedgerEntry[];
  usageRows: UsageEntry[];
}): WalletReconciliation {
  const { creditsTotal, sumOfLedgerDeltas, latestLedgerBalance, usageLogCostCents } = input;
  return {
    creditsTotal,
    sumOfLedgerDeltas,
    latestLedgerBalance,
    creditsTotalEqualsSumOfLedgerDeltas: creditsTotal === sumOfLedgerDeltas,
    creditsTotalEqualsLatestLedgerBalance: latestLedgerBalance == null || creditsTotal === latestLedgerBalance,
    usageLogCostCents,
    creditsTotalEqualsUsageLogCostCents: creditsTotal === usageLogCostCents,
    chargedWithoutUsageLog: chargedWithoutUsageLog(input.ledgerRows, input.usageRows),
  };
}
