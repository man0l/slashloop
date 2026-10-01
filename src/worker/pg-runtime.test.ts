import { describe, expect, test, afterAll, beforeEach, afterEach } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';
import {
  completeJob,
  failJob,
  setJobLifecycleSink,
  yieldJob,
} from '../lib/jobs.js';
import {
  isPgOwned,
  markPgOwned,
  resetPgOwnedForTests,
  workerId,
} from './pg-runtime.js';

/**
 * The D1 side of the store, faked: the sink under test is supposed to hand PG
 * ids back to Postgres and let D1 ids fall through to the D1 write. This fake
 * makes the fall-through observable without a database.
 *
 * It used to be inferred from a REAL client — this file asserted that
 * `completeJob('d1-1')` throws, which only held when DATABASE_URL pointed at
 * some reachable database that happened to lack a MediaJob table. On a
 * checkout without DATABASE_URL it threw for a different reason ("Database
 * client not initialized"), and with a reachable one it spent a round trip
 * proving it. Under a `bun test` run it also went green/red on discovery order,
 * because other files replaced `src/db.js` wholesale (see
 * docs/test-suite-policy.md) and this file imported the real jobs.ts path only
 * by luck of arriving first.
 */
class D1PathReached extends Error {
  constructor(public readonly op: string) {
    super(`D1 path reached: ${op}`);
    this.name = 'D1PathReached';
  }
}

const d1Ops: string[] = [];
const restoreStore = swapActiveClientForTests({
  mediaJob: {
    update: async () => { d1Ops.push('update'); throw new D1PathReached('mediaJob.update'); },
    findUnique: async () => { d1Ops.push('findUnique'); throw new D1PathReached('mediaJob.findUnique'); },
  },
  $executeRaw: async () => { d1Ops.push('$executeRaw'); throw new D1PathReached('$executeRaw'); },
} as unknown as AppPrismaClient);

describe('pg-runtime ownership', () => {
  beforeEach(() => resetPgOwnedForTests());
  // Both of these are module-level singletons in jobs.ts / pg-runtime.ts. Left
  // set, they change what a LATER test file's completeJob/failJob/yieldJob do,
  // which is the second half of the same isolation rule.
  afterEach(() => { resetPgOwnedForTests(); setJobLifecycleSink(null); });
  afterAll(() => restoreStore());

  test('workerId includes pid', () => {
    expect(workerId()).toContain(String(process.pid));
  });

  test('markPgOwned tracks claimed ids', () => {
    markPgOwned(['a', 'b']);
    expect(isPgOwned('a')).toBe(true);
    expect(isPgOwned('c')).toBe(false);
  });

  test('lifecycle sink ignores D1 ids and handles PG ids', async () => {
    const pg = { complete: [] as string[], fail: [] as string[], yield: [] as string[] };
    markPgOwned(['pg-1']);
    setJobLifecycleSink({
      async completeJob(id) {
        if (!isPgOwned(id)) return false;
        pg.complete.push(id);
        return true;
      },
      async failJob(id) {
        if (!isPgOwned(id)) return null;
        pg.fail.push(id);
        return { terminal: true };
      },
      async yieldJob(id) {
        if (!isPgOwned(id)) return false;
        pg.yield.push(id);
        return true;
      },
    });

    // D1 id: the sink declines, so completeJob must go on to the D1 write. The
    // fake client throws a sentinel there, which says exactly that the fall-
    // through happened — and says it without a database.
    let d1Complete = false;
    try {
      await completeJob('d1-1', null);
    } catch (err) {
      d1Complete = err instanceof D1PathReached;
    }
    expect(pg.complete).toEqual([]);
    expect(d1Complete).toBe(true);

    await completeJob('pg-1', null);
    expect(pg.complete).toEqual(['pg-1']);

    markPgOwned(['pg-2']);
    const failed = await failJob('pg-2', 'boom', { terminal: true });
    expect(failed).toEqual({ terminal: true });
    expect(pg.fail).toEqual(['pg-2']);

    markPgOwned(['pg-3']);
    await yieldJob('pg-3', 'not started');
    expect(pg.yield).toEqual(['pg-3']);
  });

  test('the PG sink is handed back, so a later caller still reaches the D1 write', async () => {
    // The afterEach above is what makes this true. Assert it rather than trust
    // it: a lifecycle sink left installed silently reroutes every later
    // completeJob in the run.
    await expect(completeJob('d1-2', null)).rejects.toBeInstanceOf(D1PathReached);
  });
});