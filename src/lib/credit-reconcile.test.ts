import { expect, test } from 'bun:test';
import { findLedgerChainBreaks, normalizeLedgerColumns, reconcileWallet, type LedgerEntry } from './credit-reconcile.js';

// SLA-166 shape: wallet ends at 288 after a create_brief :preauth of -2,
// UsageLog cost stays $13.35, and no UsageLog row is written that day.
// Earlier deltas are a complete stand-in ledger that walks the balance down to
// that wallet (the live book has more rows; the -2 row is the one from the
// incident).
const INCIDENT_LEDGER: LedgerEntry[] = [
  { delta: 510, reason: 'adjustment', tool: null, balanceAfter: 510, refId: 'opening', createdAt: '2026-09-29T07:59:50Z' },
  { delta: 200, reason: 'adjustment', tool: null, balanceAfter: 710, refId: 'sla16-qa-grant:faceless-gen', createdAt: '2026-09-30T07:42:32Z' },
  { delta: -420, reason: 'tool_call', tool: 'experiment', balanceAfter: 290, refId: 'exp:charges', createdAt: '2026-09-30T07:48:29Z' },
  { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: '8f0e:preauth', createdAt: '2026-10-30T10:36:20Z' },
];

/** get_usage hands reconcileWallet rows NEWEST first. */
const newestFirst = (rows: LedgerEntry[]) => [...rows].reverse();

test('before reconciliation, credits.total is not the usage-log sum', () => {
  const usageLogCostCents = 1335; // $13.35, unchanged across the drop
  const creditsTotal = 288;
  expect(creditsTotal).not.toBe(usageLogCostCents);
});

test('after reconciliation, credits.total matches the newest ledger balance and flags the silent preauth', () => {
  const report = reconcileWallet({
    creditsTotal: 288,
    latestLedgerBalance: 288,
    usageLogCostCents: 1335,
    ledgerRows: newestFirst(INCIDENT_LEDGER),
    usageRows: [{ costCents: 1335, createdAt: '2026-09-29T07:59:43Z' }],
  });

  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
  expect(report.ledgerChainIntact).toBe(true);
  expect(report.ledgerChainBreaks).toEqual([]);
  expect(report.creditsTotalEqualsUsageLogCostCents).toBe(false);
  expect(report.chargedWithoutUsageLog.map((row) => row.refId)).toEqual(['8f0e:preauth']);
});

test('a refunded preauth and a brief that wrote UsageLog are not flagged', () => {
  const report = reconcileWallet({
    creditsTotal: 290,
    latestLedgerBalance: 290,
    usageLogCostCents: 1,
    ledgerRows: newestFirst([
      { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: 'a:preauth', createdAt: '2026-09-30T10:36:20Z' },
      { delta: 2, reason: 'call_failed', tool: 'create_brief', balanceAfter: 290, refId: 'a:fail', createdAt: '2026-09-30T10:36:21Z' },
      { delta: -2, reason: 'tool_call', tool: 'create_brief', balanceAfter: 288, refId: 'b:preauth', createdAt: '2026-09-30T11:00:00Z' },
    ]),
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
    latestLedgerBalance: 288,
    usageLogCostCents: 0,
    ledgerRows: [row],
    usageRows: [],
  });
  expect(report.chargedWithoutUsageLog.map((entry) => entry.refId)).toEqual([
    '7d10b06e-3400-485a-9dbc-8a921779d224:preauth',
  ]);
});

// ---------------------------------------------------------------------------
// The two corruption classes the reconciliation exists to catch. Both were the
// acceptance criteria for SLA-326: a wallet that moved with no ledger row, and
// a ledger row that was deleted, inserted, or hand-edited. The full-slice
// SUM(delta) that used to run on every get_usage call caught the first only by
// accident, and the second not at all when the row sat outside the window.
// ---------------------------------------------------------------------------

test('a wallet that moved with no ledger row behind it is reported', () => {
  // Someone edited Workspace.planCredits directly: the wallet says 500, the
  // newest ledger row still says 490. The window chain is perfectly intact —
  // only the wallet-vs-ledger comparison catches this.
  const report = reconcileWallet({
    creditsTotal: 500,
    latestLedgerBalance: 490,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 490, refId: 'a:preauth', createdAt: '2026-09-30T10:00:00Z' },
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 500, refId: 'b:preauth', createdAt: '2026-09-30T09:00:00Z' },
    ]),
    usageRows: [],
  });

  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(false);
  expect(report.ok).toBe(false);
});

test('a ledger row deleted inside the window breaks the chain and is reported', () => {
  // Three -10 debits walked 520 -> 510 -> 500 -> 490. The middle row was
  // deleted, so 490 and 510 are left with no predecessor in the window.
  const withMiddleRow = reconcileWallet({
    creditsTotal: 490,
    latestLedgerBalance: 490,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 510, refId: 'a:preauth', createdAt: '2026-09-30T09:00:00Z' },
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 500, refId: 'b:preauth', createdAt: '2026-09-30T10:00:00Z' },
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 490, refId: 'c:preauth', createdAt: '2026-09-30T11:00:00Z' },
    ]),
    usageRows: [],
  });
  expect(withMiddleRow.ledgerChainIntact).toBe(true);
  expect(withMiddleRow.ledgerChainBreaks).toEqual([]);
  expect(withMiddleRow.ok).toBe(true);

  const afterDeletion = reconcileWallet({
    creditsTotal: 490,
    latestLedgerBalance: 490,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 510, refId: 'a:preauth', createdAt: '2026-09-30T09:00:00Z' },
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 490, refId: 'c:preauth', createdAt: '2026-09-30T11:00:00Z' },
    ]),
    usageRows: [],
  });

  expect(afterDeletion.ledgerChainIntact).toBe(false);
  expect(afterDeletion.ok).toBe(false);
  // The oldest row (a) is dropped: its predecessor was always outside the
  // window. The newest row (c) is the break — 500 is nowhere in the window.
  expect(afterDeletion.ledgerChainBreaks).toEqual([
    {
      refId: 'c:preauth',
      createdAt: '2026-09-30T11:00:00Z',
      expectedBalanceAfter: 500,
      actualBalanceAfter: 490,
      drift: 0,
    },
  ]);
});

test('a hand-edited delta inside the window is reported', () => {
  // The 2-credit corruption found in production on 2026-09-01 (workspace
  // 63c754e4): the row says -8 but the balance only moved 6, so the
  // predecessor it implies (70) is not the 68 that is actually stored.
  const breaks = findLedgerChainBreaks(newestFirst([
    { delta: -6, reason: 'tool_call', tool: null, balanceAfter: 68, refId: 'y:preauth', createdAt: '2026-09-01T13:03:00.000Z' },
    { delta: -8, reason: 'tool_call', tool: null, balanceAfter: 62, refId: 'x:preauth', createdAt: '2026-09-01T13:03:54.779Z' },
  ]));

  expect(breaks).toEqual([
    {
      refId: 'x:preauth',
      createdAt: '2026-09-01T13:03:54.779Z',
      expectedBalanceAfter: 70,
      actualBalanceAfter: 62,
      drift: 0,
    },
  ]);
});

test('concurrent writes whose committed order differs from createdAt are not breaks', () => {
  // Production workspace b2967893, 2026-10-01. Two debits 4ms apart: the row
  // stamped .541 stored balanceAfter 274 and the row stamped .545 stored 282,
  // so the .545 batch committed FIRST. A check that walks rows in createdAt
  // order reports this healthy ledger as corrupt. Set membership does not,
  // because it never assumes an order the table does not store.
  const report = reconcileWallet({
    creditsTotal: 274,
    latestLedgerBalance: 274,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 282, refId: 'later-stamp:preauth', createdAt: '2026-10-01T18:01:48.545Z' },
      { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 274, refId: 'earlier-stamp:preauth', createdAt: '2026-10-01T18:01:48.541Z' },
    ]),
    usageRows: [],
  });

  expect(report.ledgerChainIntact).toBe(true);
  expect(report.ledgerChainBreaks).toEqual([]);
  expect(report.ok).toBe(true);
});

test('two debits in the same millisecond are not breaks', () => {
  // D1 rawBatch writers routinely commit two debits in one millisecond.
  const report = reconcileWallet({
    creditsTotal: 260,
    latestLedgerBalance: 260,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 268, refId: 'a:preauth', createdAt: '2026-10-01T18:02:00.877Z' },
      { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 260, refId: 'b:preauth', createdAt: '2026-10-01T18:02:00.877Z' },
    ]),
    usageRows: [],
  });
  expect(report.ledgerChainIntact).toBe(true);
  expect(report.ok).toBe(true);
});

test('a real production workspace with debits, refunds and out-of-order commits chains cleanly', () => {
  // Verbatim from workspace b2967893 on 2026-10-02 (13 rows, its whole ledger),
  // oldest first. It contains every shape that made earlier versions of this
  // check report a phantom: a commit order that inverts createdAt (the .541 /
  // .545 pair), two debits in the same millisecond (the 18:02:00.877 pair), and
  // refunds interleaved with debits so balanceAfter is not monotonic. The
  // wallet reads 284, which is this window's newest balanceAfter.
  const REAL_WORKSPACE_B2967893: LedgerEntry[] = [
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 292, refId: '706d6385:preauth', createdAt: '2026-09-28T02:52:05.471Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 284, refId: '4836580d:preauth', createdAt: '2026-09-28T03:22:06.571Z' },
    { delta: 6, reason: 'usage_settlement', tool: 'refresh_source', balanceAfter: 290, refId: '4836580d:settle', createdAt: '2026-09-28T03:22:32.409Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 274, refId: '955139d8:preauth', createdAt: '2026-10-01T18:01:48.541Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 282, refId: 'b676c8ed:preauth', createdAt: '2026-10-01T18:01:48.545Z' },
    { delta: 2, reason: 'usage_settlement', tool: 'refresh_source', balanceAfter: 276, refId: 'b676c8ed:settle', createdAt: '2026-10-01T18:01:59.944Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 268, refId: '68b86f70:preauth', createdAt: '2026-10-01T18:02:00.877Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 260, refId: '6f220c7f:preauth', createdAt: '2026-10-01T18:02:00.877Z' },
    { delta: 8, reason: 'usage_settlement', tool: 'refresh_source', balanceAfter: 268, refId: '6f220c7f:settle', createdAt: '2026-10-01T18:02:03.849Z' },
    { delta: 8, reason: 'usage_settlement', tool: 'refresh_source', balanceAfter: 276, refId: '68b86f70:settle', createdAt: '2026-10-01T18:02:04.119Z' },
    { delta: -8, reason: 'tool_call', tool: 'refresh_source', balanceAfter: 268, refId: '5fe17f3f:preauth', createdAt: '2026-10-01T18:02:05.054Z' },
    { delta: 8, reason: 'usage_settlement', tool: 'refresh_source', balanceAfter: 276, refId: '5fe17f3f:settle', createdAt: '2026-10-01T18:02:07.905Z' },
    { delta: 8, reason: 'call_failed', tool: 'refresh_source', balanceAfter: 284, refId: '955139d8:fail', createdAt: '2026-10-01T18:12:05.648Z' },
  ];

  const report = reconcileWallet({
    creditsTotal: 284,
    latestLedgerBalance: 284,
    usageLogCostCents: 0,
    ledgerRows: newestFirst(REAL_WORKSPACE_B2967893),
    usageRows: [],
  });

  expect(report.ledgerChainIntact).toBe(true);
  expect(report.ledgerChainBreaks).toEqual([]);
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
  expect(report.ok).toBe(true);
});

test('a window with fewer than two rows does not claim the chain is intact', () => {
  const report = reconcileWallet({
    creditsTotal: 490,
    latestLedgerBalance: 490,
    usageLogCostCents: 0,
    ledgerRows: [
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 490, refId: 'a:preauth', createdAt: '2026-09-30T10:00:00Z' },
    ],
    usageRows: [],
  });
  // null, not true: one row cannot disprove a deletion, and claiming `true`
  // would overstate what the check actually established.
  expect(report.ledgerChainIntact).toBeNull();
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
});

test('a workspace with no ledger at all does not report a discrepancy', () => {
  const report = reconcileWallet({
    creditsTotal: 300,
    latestLedgerBalance: null,
    usageLogCostCents: 0,
    ledgerRows: [],
    usageRows: [],
  });
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
  expect(report.ledgerChainIntact).toBeNull();
  expect(report.ok).toBe(true);
});

test('a plan-cycle reset does not read as a discrepancy', () => {
  // txSetPlan records a reset as `new allotment - previous`, so the running
  // sum of deltas permanently diverges from the wallet. That is by design and
  // must not surface as a finding — this is the case that made the old
  // full-slice SUM report false discrepancies on every production workspace.
  const report = reconcileWallet({
    creditsTotal: 3000,
    latestLedgerBalance: 3000,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: 3000, reason: 'subscription_renewal', tool: null, balanceAfter: 3000, refId: 'evt_renew', createdAt: '2026-08-03T08:35:03Z' },
      { delta: -2700, reason: 'subscription_canceled', tool: null, balanceAfter: 0, refId: 'evt_cancel', createdAt: '2026-07-30T10:01:01Z' },
      { delta: 300, reason: 'adjustment', tool: null, balanceAfter: 2700, refId: 'opening', createdAt: '2026-07-30T09:00:00Z' },
    ]),
    usageRows: [],
  });

  expect(report.ok).toBe(true);
  expect(report.ledgerChainIntact).toBe(true);
  expect(report.creditsTotalEqualsLatestLedgerBalance).toBe(true);
});

test('the opt-in full audit is reported as drift, not as a pass/fail', () => {
  const report = reconcileWallet({
    creditsTotal: 3000,
    latestLedgerBalance: 3000,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: 3000, reason: 'subscription_renewal', tool: null, balanceAfter: 3000, refId: 'evt_renew', createdAt: '2026-08-03T08:35:03Z' },
    ]),
    usageRows: [],
    fullLedgerAudit: { sumOfLedgerDeltas: 8450, rowCount: 17331, driftFromWallet: -5450, rowsRead: 17332 },
  });

  expect(report.fullLedgerAudit).toEqual({
    sumOfLedgerDeltas: 8450,
    rowCount: 17331,
    driftFromWallet: -5450,
    rowsRead: 17332,
  });
  // The audit is informational. A drifted sum on a plan-reset account must not
  // flip `ok` — that is exactly the false alarm this replaced.
  expect(report.ok).toBe(true);
});

test('the full audit is absent unless the caller asked for it', () => {
  const report = reconcileWallet({
    creditsTotal: 490,
    latestLedgerBalance: 490,
    usageLogCostCents: 0,
    ledgerRows: newestFirst([
      { delta: -10, reason: 'tool_call', tool: 'analyze_video', balanceAfter: 490, refId: 'a:preauth', createdAt: '2026-09-30T10:00:00Z' },
    ]),
    usageRows: [],
  });
  expect(report.fullLedgerAudit).toBeUndefined();
});
