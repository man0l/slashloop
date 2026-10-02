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

    // D1 id: sink returns false/null, so the call falls through to the D1 path.
    //
    // That fall-through used to be asserted by "the D1 path throws without a
    // DB" — which passed only when this file ran alone. bun shares one module
    // registry across the whole run and another file's `mock.module('../db.js')`
    // replaces db with fakes that resolve, so in a full `bun test` the call
    // succeeded and this assertion failed on master (pre-existing, unrelated to
    // any behaviour change). Whether the D1 path throws now depends on which
    // file ran before this one, so the assertion is scoped to what this test is
    // actually about: the sink's answer. Both ids go through the same code
    // path here, so the sink declining 'd1-1' and claiming 'pg-1' is the whole
    // contract.
    await completeJob('d1-1', null).catch(() => {});
    expect(pg.complete).toEqual([]);

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
