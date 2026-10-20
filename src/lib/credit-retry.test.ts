import { afterAll, beforeEach, expect, mock, test } from 'bun:test';

/**
 * Retry-specific cover for the raw-batch replay branch. The SQL statement
 * contract is covered by credit-sql.test.ts; this pins the caller-visible
 * contract when the transactional bridge reports the CreditLedger conflict.
 *
 * Other test files mock.module './credits.js', '../store.js' and '../db.js',
 * and bun keeps those mocks for the whole process. So this file does not rely
 * on whatever the registry holds: it loads fresh copies of the real modules
 * through query-suffixed specifiers (not variables, so tsc does not try to
 * resolve them), registers its own store/db mocks, and only then loads a fresh
 * credits.ts that binds to them. The previous registry entries are put back
 * in afterAll.
 */
const originalDialect = process.env.DB_DIALECT;
beforeEach(() => {
  process.env.DB_DIALECT = 'sqlite';
});

const storeSpecifier = '../store.js';
const dbSpecifier = '../db.js';
const creditsSpecifier = './credits.js';
const tag = '?credit-retry';

const storeBefore = await import(storeSpecifier);
const dbBefore = await import(dbSpecifier);
const realStore = await import(storeSpecifier + tag);
const realDb = await import(dbSpecifier + tag);

let throwCreditConflict = false;
mock.module(storeSpecifier, () => ({
  ...realStore,
  rawBatch: (statements: unknown) => {
    if (throwCreditConflict) {
      throw new Error(
        'D1 batch via worker failed: D1_ERROR: UNIQUE constraint failed: '
        + 'CreditLedger.workspaceId, CreditLedger.refId',
      );
    }
    return realStore.rawBatch(statements);
  },
}));

const balance = { planCredits: 12, packCredits: 8 };
const fakeDb = {
  workspace: {
    findUnique: async () => null,
    findUniqueOrThrow: async () => ({ ...balance }),
  },
};
mock.module(dbSpecifier, () => ({ ...realDb, db: fakeDb }));

const { debitCredits } = await import(creditsSpecifier + tag);

afterAll(() => {
  throwCreditConflict = false;
  mock.module(storeSpecifier, () => storeBefore);
  mock.module(dbSpecifier, () => dbBefore);
  if (originalDialect === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = originalDialect;
});

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
  }
});
