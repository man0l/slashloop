// Tests for src/lib/ledger-recent.ts — the index-friendly replacement for
// get_usage's CASE-ordered CreditLedger read.
//
// Two things are under test:
//   1. The SQL stays index-shaped. A regression back to a CASE ORDER BY (or a
//      LIKE) reintroduces a full workspace scan, which is the D1 Free-tier
//      daily row-read blowup this module exists to prevent. Asserting on the
//      SQL string is the cheapest guard that catches it without a live D1.
//   2. The merge reproduces what the single CASE query returned, including the
//      swapped-column rows the CASE existed to handle.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  fetchRecentLedgerRows,
  FULL_LEDGER_AUDIT_SQL,
  mergeRecentLedgerRows,
  RECENT_LEDGER_QUERIES,
  type RawLedgerRow,
} from './ledger-recent.js';

const iso = (s: string) => new Date(s).toISOString();

function row(over: Partial<RawLedgerRow> & { refId: string; createdAt: string }): RawLedgerRow {
  return {
    delta: -2,
    reason: 'tool_call',
    tool: 'create_brief',
    balanceAfter: 100,
    ...over,
  } as RawLedgerRow;
}

describe('RECENT_LEDGER_QUERIES shape', () => {
  test('neither query contains a CASE ORDER BY over the workspace slice', () => {
    for (const sql of Object.values(RECENT_LEDGER_QUERIES)) {
      expect(sql).not.toMatch(/ORDER BY\s+CASE/i);
      expect(sql).not.toMatch(/CASE\s+WHEN/i);
    }
  });

  test('neither query uses LIKE — LIKE cannot use an index and reads the slice', () => {
    for (const sql of Object.values(RECENT_LEDGER_QUERIES)) {
      expect(sql).not.toMatch(/LIKE/i);
    }
  });

  test('the createdAt read orders by the column it filters on, index-first', () => {
    const sql = RECENT_LEDGER_QUERIES.inCreatedAt;
    expect(sql).toMatch(/"createdAt"\s*>=\s*'2000-01-01'/);
    expect(sql).toMatch(/ORDER BY\s+"createdAt"\s+DESC/);
  });

  test('the refId read is a bounded range on the unique index, not a scan', () => {
    const sql = RECENT_LEDGER_QUERIES.inRefId;
    expect(sql).toMatch(/"refId"\s*>=\s*'20'\s+AND\s+"refId"\s*<\s*'21'/);
    expect(sql).toMatch(/ORDER BY\s+"refId"\s+DESC/);
  });

  test('both reads are workspace-scoped and LIMIT-ed to the caller take', () => {
    for (const sql of Object.values(RECENT_LEDGER_QUERIES)) {
      expect(sql).toMatch(/"workspaceId"\s*=\s*\$1/);
      expect(sql).toMatch(/LIMIT\s+\$2/);
    }
  });

  test('both reads CAST createdAt to text so Prisma never decodes it as a DateTime', () => {
    for (const sql of Object.values(RECENT_LEDGER_QUERIES)) {
      expect(sql).toMatch(/CAST\("createdAt" AS TEXT\) AS "createdAt"/);
    }
  });
});

describe('FULL_LEDGER_AUDIT_SQL', () => {
  // SLA-326: this query used to run inline on every get_usage call. It reads
  // every CreditLedger row for the workspace (17,332 rows on the largest
  // production workspace) against a 5,000,000 rows/day account cap, and it
  // reported a false discrepancy on every production workspace. It is now
  // opt-in. These assertions are the guard against it creeping back.
  test('it is the unbounded whole-slice aggregate, not a windowed read', () => {
    expect(FULL_LEDGER_AUDIT_SQL).toMatch(/SUM\("delta"\)/);
    expect(FULL_LEDGER_AUDIT_SQL).toMatch(/COUNT\(\*\)/);
    // No LIMIT, no createdAt range: this is the scan.
    expect(FULL_LEDGER_AUDIT_SQL).not.toMatch(/LIMIT/i);
    expect(FULL_LEDGER_AUDIT_SQL).not.toMatch(/createdAt/i);
  });

  test('get_usage exposes it only as an opt-in that defaults to off', async () => {
    const settings = await readFile(new URL('../tools/settings.ts', import.meta.url), 'utf8');

    // Reachable, but the parameter defaults to false and the call is guarded
    // by it, so the scan cannot run unless a caller asks for it by name.
    expect(settings).toMatch(/auditFullLedger:\s*z\.boolean\(\)\.default\(false\)/);
    expect(settings).toMatch(/const fullLedgerAudit = auditFullLedger\s*\n?\s*\?/);
  });
});

describe('mergeRecentLedgerRows', () => {
  test('orders newest first', () => {
    const merged = mergeRecentLedgerRows([
      row({ refId: 'a', createdAt: '2026-10-01T10:00:00.000Z' }),
      row({ refId: 'c', createdAt: '2026-10-01T12:00:00.000Z' }),
      row({ refId: 'b', createdAt: '2026-10-01T11:00:00.000Z' }),
    ], 10);
    expect(merged.map((r) => r.refId)).toEqual(['c', 'b', 'a']);
  });

  test('honours take', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ refId: `r${i}`, createdAt: iso(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()) }),
    );
    expect(mergeRecentLedgerRows(rows, 20)).toHaveLength(20);
    expect(mergeRecentLedgerRows(rows, 20)[0].refId).toBe('r49');
  });

  test('dedupes the same row returned by both reads', () => {
    const shared = row({ refId: 'shared', createdAt: '2026-10-01T10:00:00.000Z' });
    const merged = mergeRecentLedgerRows([shared, { ...shared }], 10);
    expect(merged).toHaveLength(1);
  });

  test('keeps distinct rows that share a refId but differ in amount', () => {
    // Same [workspaceId, refId] cannot happen in the real table (unique index),
    // but a partial refund/settle pair can differ in delta — do not collapse it.
    const merged = mergeRecentLedgerRows([
      row({ refId: 'op:preauth', delta: -2, createdAt: '2026-10-01T10:00:00.000Z' }),
      row({ refId: 'op:preauth', delta: 2, createdAt: '2026-10-01T10:05:00.000Z' }),
    ], 10);
    expect(merged).toHaveLength(2);
  });

  test('a swapped row is ordered by the timestamp that lives in refId', () => {
    // The bind bug put the clock in refId and the idempotency key in createdAt.
    // Scored by its raw createdAt this row would sort as a non-date; scored by
    // the real clock it lands where it belongs.
    const merged = mergeRecentLedgerRows([
      row({ refId: '2026-08-13T17:21:34.207Z', createdAt: 'sla16-recreate-canary-grant:cf7b725d' }),
      row({ refId: '9cd109d6-a6e8-4037-870b-b270a03a6e30:preauth', createdAt: '2026-08-15T10:00:00.000Z' }),
    ], 10);
    expect(merged[0].createdAt).toBe('2026-08-15T10:00:00.000Z');
    expect(merged[1].createdAt).toBe('2026-08-13T17:21:34.207Z');
    expect(merged[1].refId).toBe('sla16-recreate-canary-grant:cf7b725d');
  });

  test('leaves correctly-ordered rows untouched', () => {
    const merged = mergeRecentLedgerRows([
      row({ refId: 'op:preauth', createdAt: '2026-10-01T10:00:00.000Z' }),
    ], 10);
    expect(merged[0]).toMatchObject({
      refId: 'op:preauth',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
  });

  test('empty input yields empty output', () => {
    expect(mergeRecentLedgerRows([], 20)).toEqual([]);
  });
});

describe('fetchRecentLedgerRows', () => {
  test('issues exactly the two index-shaped reads and merges them', async () => {
    const seen: string[] = [];
    const query = async (sql: string, ...params: unknown[]) => {
      seen.push(sql);
      expect(params).toEqual(['ws-1', 20]);
      if (sql === RECENT_LEDGER_QUERIES.inCreatedAt) {
        return [
          row({ refId: 'newer', createdAt: '2026-10-01T12:00:00.000Z' }),
          row({ refId: 'older', createdAt: '2026-10-01T09:00:00.000Z' }),
        ];
      }
      return [row({ refId: '2026-08-13T17:21:34.207Z', createdAt: 'sla16-grant:x' })];
    };

    const merged = await fetchRecentLedgerRows(query, 'ws-1', 20);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(RECENT_LEDGER_QUERIES.inCreatedAt);
    expect(seen[1]).toBe(RECENT_LEDGER_QUERIES.inRefId);
    // Newest first: the 12:00 row, then the 09:00 row, then the swapped
    // 2026-08-13 row (dated by its refId clock).
    expect(merged.map((r) => r.createdAt)).toEqual([
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T09:00:00.000Z',
      '2026-08-13T17:21:34.207Z',
    ]);
    expect(merged[2].refId).toBe('sla16-grant:x');
  });

  test('a workspace with no swapped rows still returns its newest rows', async () => {
    const query = async (sql: string) =>
      sql === RECENT_LEDGER_QUERIES.inCreatedAt
        ? [row({ refId: 'a', createdAt: '2026-10-01T10:00:00.000Z' })]
        : [];
    expect(await fetchRecentLedgerRows(query, 'ws-1', 20)).toHaveLength(1);
  });
});
