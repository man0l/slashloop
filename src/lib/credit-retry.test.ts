import { afterAll, beforeEach, expect, mock, test } from 'bun:test';

/**
 * Retry-specific cover for the raw-batch replay branch. The SQL statement
 * contract is covered by credit-sql.test.ts; this pins the caller-visible
 * contract when the transactional bridge reports the CreditLedger conflict.
 */
const originalDialect = process.env.DB_DIALECT;
beforeEach(() => {
  process.env.DB_DIALECT = 'sqlite';
});

const storeBefore = await import('../store.js');
// Snapshot by value and put back in afterAll: mock.module rewrites the shared
// registry for the whole `bun test` process, so these stubs would otherwise
// outlive the file (same pattern as recreate-dedupe.test.ts).
const STORE_BEFORE = { ...storeBefore };
let throwCreditConflict = false;
mock.module('../store.js', () => ({
  ...storeBefore,
  // Pinned rather than read from DB_DIALECT: mock.module persists across test
  // files, and queue/transport.test.ts leaves a '../db.js' stub whose
  // dbDialect is 'postgres' — spread into storeBefore, it would route
  // debitCredits down the $transaction path this fake db does not have.
  dbDialect: () => 'sqlite',
  rawBatch: (statements: Parameters<typeof storeBefore.rawBatch>[0]) => {
    if (throwCreditConflict) {
      throw new Error(
        'D1 batch via worker failed: D1_ERROR: UNIQUE constraint failed: '
        + 'CreditLedger.workspaceId, CreditLedger.refId',
      );
    }
    return storeBefore.rawBatch(statements);
  },
}));

const balance = { planCredits: 12, packCredits: 8 };
const fakeDb = {
  workspace: {
    findUnique: async () => null,
    findUniqueOrThrow: async () => ({ ...balance }),
  },
};
const dbBefore = await import('../db.js');
const DB_BEFORE = { ...dbBefore };
afterAll(() => {
  mock.module('../store.js', () => ({ ...STORE_BEFORE }));
  mock.module('../db.js', () => ({ ...DB_BEFORE }));
});
mock.module('../db.js', () => ({
  ...dbBefore,
  db: fakeDb,
}));

// A fresh instance: if another file already loaded credits.js, the cached
// module keeps whatever db/store stubs were live then, not the ones above.
const freshCredits: string = './credits.js?credit-retry';
const { debitCredits } = (await import(freshCredits)) as typeof import('./credits.js');

test('a duplicate debit refId replays the unchanged balance without an error log', async () => {
  throwCreditConflict = true;
  const errorLogs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errorLogs.push(args);

  try {
    await expect(debitCredits('w', 5, 'tool_call', 'retry-1')).resolves.toEqual({
      planCredits: 12,
      packCredits: 8,
      total: 20,
      replayed: true,
    });
    expect(balance).toEqual({ planCredits: 12, packCredits: 8 });
    expect(errorLogs).toEqual([]);
  } finally {
    console.error = originalError;
    if (originalDialect === undefined) delete process.env.DB_DIALECT;
    else process.env.DB_DIALECT = originalDialect;
  }
});
