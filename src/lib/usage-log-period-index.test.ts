// Guard for the D1 index that makes get_usage's period read bounded.
//
// SLA-326 follow-up (founder asked why get_usage still reads ~2,480 rows once
// the ledger SUM was gone). The remainder was the UsageLog period read:
//
//   SELECT * FROM "UsageLog"
//    WHERE "workspaceId" = ? AND "createdAt" >= ? ORDER BY "createdAt" DESC
//
// Measured 2026-10-02 on the largest production workspace: 2,480 rows read for
// a period holding TEN rows, because no index led with (workspaceId, createdAt)
// — so SQLite sought workspaceId, filtered the date range row by row, and
// sorted in a temp B-tree. Adding LIMIT does not help; the sort precedes it.
//
// These tests pin the index in all three places it has to live, plus the
// property that actually matters: createdAt must LEAD after workspaceId. The
// 0007 index has createdAt last, which is exactly why it could not serve this.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const MIGRATION = '../../prisma/d1-migrations/0015_usage_log_workspace_createdat_idx.sql';
const INDEX_NAME = 'UsageLog_workspaceId_createdAt_idx';

function migrationSql(): string {
  return readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
}

test('the migration creates the index and is safe to re-run', () => {
  const sql = migrationSql();
  expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "${INDEX_NAME}"`);
  expect(sql).toContain('ON "UsageLog"("workspaceId", "createdAt")');
});

test('both Prisma schemas declare the same index', () => {
  for (const schema of ['schema.prisma', 'schema.sqlite.prisma']) {
    const text = readFileSync(new URL(`../../prisma/${schema}`, import.meta.url), 'utf8');
    const usageLog = text.slice(text.indexOf('model UsageLog'), text.indexOf('model RefreshRun'));
    expect(usageLog).toContain('@@index([workspaceId, createdAt])');
  }
});

test('the index leads with workspaceId then createdAt — the order the query needs', () => {
  // The 0007 UsageLog(workspaceId, kind, provider, createdAt) index exists and
  // still cannot serve this read: createdAt is its last column, so neither the
  // range nor the ORDER BY is index-ordered. Assert the column order, not just
  // the presence, so a future edit cannot quietly reintroduce that shape.
  const sql = migrationSql();
  const match = sql.match(/ON "UsageLog"\(([^)]+)\)/);
  expect(match).not.toBeNull();
  const columns = (match![1].match(/"([^"]+)"/g) ?? []).map((c) => c.replace(/"/g, ''));
  expect(columns).toEqual(['workspaceId', 'createdAt']);
});

/**
 * The behavioural proof, on a replica shaped like production. This is the
 * assertion that would have caught the bug: the period read must become a
 * bounded range seek with no temp B-tree, instead of a workspaceId seek plus a
 * sort over the whole slice.
 */
test('the index turns the period read into a range seek with no temp B-tree', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE "UsageLog"(id TEXT PRIMARY KEY, "workspaceId" TEXT, "kind" TEXT,
          provider TEXT, units INTEGER, "costCents" INTEGER, "refId" TEXT, "createdAt" TEXT)`);
  // Production shape for the largest workspace: 27 Jul, 1207 Aug, 1225 Sep, 10 Oct.
  const insert = db.prepare('INSERT INTO "UsageLog" VALUES (?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const [month, count] of [['2026-07', 27], ['2026-08', 1207], ['2026-09', 1225], ['2026-10', 10]] as const) {
    for (let i = 0; i < count; i++) {
      insert.run(`id${n++}`, 'ws1', i % 2 ? 'ai' : 'scrape', 'apify', 1, 3, null,
        `${month}-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`);
    }
  }
  // Exactly the indexes that exist on production before this migration.
  db.run(`CREATE INDEX "UsageLog_workspaceId_idx" ON "UsageLog"("workspaceId")`);
  db.run(`CREATE INDEX "UsageLog_kind_idx" ON "UsageLog"("kind")`);
  db.run(`CREATE INDEX "UsageLog_createdAt_idx" ON "UsageLog"("createdAt")`);
  db.run(`CREATE INDEX "UsageLog_workspace_kind_provider_createdAt_idx"
          ON "UsageLog"("workspaceId","kind","provider","createdAt")`);

  const PERIOD = 'SELECT * FROM "UsageLog" WHERE "workspaceId"=? AND "createdAt">=? ORDER BY "createdAt" DESC';
  const plan = () => db.query(`EXPLAIN QUERY PLAN ${PERIOD}`).all('ws1', '2026-10-01')
    .map((r) => String((r as { detail: string }).detail)).join(' | ');

  const before = plan();
  expect(before).toContain('UsageLog_workspaceId_idx');
  expect(before).toContain('USE TEMP B-TREE FOR ORDER BY');

  db.run(`CREATE INDEX "${INDEX_NAME}" ON "UsageLog"("workspaceId","createdAt")`);

  const after = plan();
  expect(after).toContain(INDEX_NAME);
  expect(after).toContain('createdAt>');
  expect(after).not.toContain('USE TEMP B-TREE FOR ORDER BY');

  // Same result either way — the index changes cost, not answers.
  const rows = db.query(PERIOD).all('ws1', '2026-10-01');
  expect(rows).toHaveLength(10);
  expect(rows[0]).toMatchObject({ workspaceId: 'ws1' });
});