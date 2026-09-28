import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
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

describe('pg-runtime ownership', () => {
  beforeEach(() => resetPgOwnedForTests());
  afterEach(() => resetPgOwnedForTests());

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

    // D1 id: sink returns false/null; D1 path then runs (and will throw without a DB).
    // We only assert the sink did not claim it.
    let d1Complete = false;
    try {
      await completeJob('d1-1', null);
    } catch {
      d1Complete = true;
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
});
