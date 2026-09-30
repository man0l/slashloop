import { expect, test } from 'bun:test';
import { reconcileWallet, type LedgerEntry } from './credit-reconcile.js';

// SLA-166 shape: wallet ends at 288 after a create_brief :preauth of -2,
// UsageLog cost stays $13.35, and no UsageLog row is written that day.
// Earlier deltas are a complete stand-in ledger that sums to that wallet
// (the live book has more rows; the -2 row is the one from the incident).
const INCIDENT_LEDGER: LedgerEntry[] = [
  { delta: 510, reason: 'adjustment', tool: null, balanceAfter: 510, refId: 'opening', createdAt: '2026-09-29T07:59:50Z' },
  { delta: 200, reason: 'adjustment', tool: null, balanceAfter: 710, refId: 'sla16-qa-grant:faceless-gen', createdAt: '2026-09-30T07:42:32Z' },
  { delta: -420, reason: 'tool_call', tool: 'experiment', balanceAfter: 290, refId: 'exp:charges', createdAt: '2026-09-30T07:48:29Z' },
  { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: '8f0e:preauth', createdAt: '2026-09-30T10:36:20Z' },
];

test('before reconciliation, credits.total is not the usage-log sum', () => {
  const usageLogCostCents = 1335; // $13.35, unchanged across the drop
  const creditsTotal = 288;
  expect(creditsTotal).not.toBe(usageLogCostCents);
});

test('after reconciliation, credits.total equals the credit-ledger sum and flags the silent preauth', () => {
  const report = reconcileWallet({
    creditsTotal: 288,
    sumOfLedgerDeltas: INCIDENT_LEDGER.reduce((n, row) => n + row.delta, 0),
    latestLedgerBalance: 288,
    usageLogCostCents: 1335,
    ledgerRows: INCIDENT_LEDGER,
    usageRows: [{ costCents: 1335, createdAt: '2026-09-29T07:59:43Z' }],
  });

  expect(report.sumOfLedgerDeltas).toBe(288);
  expect(report.creditsTotalEqualsSumOfLedgerDeltas).toBe(true);
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
  expect(report.creditsTotalEqualsUsageLogCostCents).toBe(false);
  expect(report.chargedWithoutUsageLog.map((row) => row.refId)).toEqual(['8f0e:preauth']);
});

test('a refunded preauth and a brief that wrote UsageLog are not flagged', () => {
  const report = reconcileWallet({
    creditsTotal: 290,
    sumOfLedgerDeltas: 290,
    latestLedgerBalance: 290,
    usageLogCostCents: 1,
    ledgerRows: [
      { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: 'a:preauth', createdAt: '2026-09-30T10:36:20Z' },
      { delta: 2, reason: 'call_failed', tool: 'create_brief', balanceAfter: 290, refId: 'a:fail', createdAt: '2026-09-30T10:36:21Z' },
      { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: 'b:preauth', createdAt: '2026-09-30T11:00:00Z' },
    ],
    usageRows: [{ costCents: 1, createdAt: '2026-09-30T11:00:02Z' }],
  });
  expect(report.chargedWithoutUsageLog).toEqual([]);
});

test('a wallet that moved with no ledger row does not reconcile', () => {
  const report = reconcileWallet({
    creditsTotal: 288,
    sumOfLedgerDeltas: 290,
    latestLedgerBalance: 290,
    usageLogCostCents: 1335,
    ledgerRows: [],
    usageRows: [],
  });
  expect(report.creditsTotalEqualsSumOfLedgerDeltas).toBe(false);
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(false);
});
