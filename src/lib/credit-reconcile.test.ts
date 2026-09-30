import { expect, test } from 'bun:test';
import { normalizeLedgerColumns, reconcileWallet, type LedgerEntry } from './credit-reconcile.js';

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

test('swapped createdAt keys are read as the idempotency ref', () => {
  // Live D1 shape: the timestamp landed in refId and the key in createdAt.
  const normalized = normalizeLedgerColumns({
    delta: 20,
    reason: 'adjustment',
    tool: 'recreate_slideshow',
    balanceAfter: 21,
    refId: '2026-09-28T02:27:59.803+00:00',
    createdAt: 'sla16-recreate-canary-grant:cf7b725d',
  });
  expect(normalized.refId).toBe('sla16-recreate-canary-grant:cf7b725d');
  expect(normalized.createdAt).toBe('2026-09-28T02:27:59.803+00:00');

  const alreadyCorrect = normalizeLedgerColumns({
    delta: 10000,
    reason: 'adjustment',
    tool: null,
    balanceAfter: 10278,
    refId: 'sla-167:board-pack-grant:10000',
    createdAt: '2026-09-30T11:09:27.000Z',
  });
  expect(alreadyCorrect.refId).toBe('sla-167:board-pack-grant:10000');
  expect(alreadyCorrect.createdAt).toBe('2026-09-30T11:09:27.000Z');
});

test('a swapped fixed-price preauth still flags after normalize', () => {
  const row = normalizeLedgerColumns({
    delta: -2,
    reason: 'tool_call',
    tool: 'create_brief',
    balanceAfter: 288,
    refId: '2026-09-30T10:36:20.765+00:00',
    createdAt: '7d10b06e-3400-485a-9dbc-8a921779d224:preauth',
  });
  const report = reconcileWallet({
    creditsTotal: 288,
    sumOfLedgerDeltas: 288,
    latestLedgerBalance: 288,
    usageLogCostCents: 0,
    ledgerRows: [row],
    usageRows: [],
  });
  expect(report.chargedWithoutUsageLog.map((entry) => entry.refId)).toEqual([
    '7d10b06e-3400-485a-9dbc-8a921779d224:preauth',
  ]);
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
