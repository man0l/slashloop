import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { creditLedgerRefAndCreatedAt } from './credit-ledger-bind.js';

test('sqlite CreditLedger binds the idempotency key to refId and the clock to createdAt', () => {
  const src = readFileSync(new URL('./credits.ts', import.meta.url), 'utf8');
  const inserts = src.split('INSERT INTO "CreditLedger"').length - 1;
  expect(inserts).toBe(3);
  expect(src.match(/creditLedgerRefAndCreatedAt\(/g)?.length).toBe(3);
  const paramLines = src.split('\n').filter((line) => line.includes('params:'));
  expect(paramLines.some((line) => line.includes('now, refId') || line.includes('now, it.refId'))).toBe(false);

  const createdAt = new Date('2026-09-30T11:22:17.720Z');
  const [refId, at] = creditLedgerRefAndCreatedAt('e3546465-6185-4b03-af0d-bea624e69df2:preauth', createdAt);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE CreditLedger(
    id TEXT PRIMARY KEY,
    workspaceId TEXT,
    delta INTEGER,
    bucket TEXT,
    reason TEXT,
    tool TEXT,
    balanceAfter INTEGER,
    refId TEXT,
    createdAt TEXT
  )`);
  db.run(
    `INSERT INTO CreditLedger (id, workspaceId, delta, bucket, reason, tool, balanceAfter, refId, createdAt)
     VALUES (?, ?, ?, 'plan', 'tool_call', ?, 1, ?, ?)`,
    ['row', 'ws', -2, 'create_brief', refId, at.toISOString()],
  );
  const row = db.query('SELECT refId, createdAt FROM CreditLedger').get() as { refId: string; createdAt: string };
  expect(row.refId).toBe('e3546465-6185-4b03-af0d-bea624e69df2:preauth');
  expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
  expect(row.createdAt.startsWith('2026-09-30')).toBe(true);
  db.close();
});
