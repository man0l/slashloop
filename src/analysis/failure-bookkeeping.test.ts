// DB-backed coverage for the analysis failure bookkeeping (SLA-477).
//
// loadFailureMap / recordFailure / recordSuccess keep 100% of their state in
// Workspace.failureCountsJson — that is the point of them, because an MCP server
// spawned per tool call cannot hold a Map. So the only way to pin the
// behaviour SLA-460 layered on top (the `hard` park) is to write to a real
// column and read it back through a fresh client. Before this file the whole
// path was exercised by production and nothing else, and the review on SLA-460
// was right that the `hard` transitions rested on assumptions nobody had run.
//
// Fixture: a throwaway SQLite file pushed from prisma/schema.sqlite.prisma —
// the same SQLite dialect the worker runs on, read and written through the same
// committed Prisma client src/generated/sqlite, so the two calls under test are
// the real `db.workspace.findUnique` / `db.workspace.update` and not a
// hand-written stand-in. Pushing from the schema (rather than copying DDL into
// this file) is what keeps the fixture honest: saveFailureMap's update returns
// the whole row, so a narrower table would fail loudly instead of quietly
// testing less.
//
// It reaches the bookkeeping through FailureCountsColumn rather than the
// process-wide `db` proxy, because suites like src/lib/recreate-dedupe replace
// '../db.js' with mock.module for the entire `bun test` process — a `db`-based
// fixture can get someone else's fake mid-run. The Prisma calls that matter
// live in this file's column implementation and in src/analysis/index.ts; what
// is tested here is the JSON contract between them.
//
// Skipped when the prisma CLI cannot push, never mocked — same rule as the PG
// half of src/queue/pg.test.ts, and loud about it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  FAILURE_TTL_MS,
  MAX_FAILURES_BEFORE_FALLBACK,
  loadFailureMap,
  recordFailure,
  recordSuccess,
  type FailureCountsColumn,
  type FailureMap,
} from './failure-map.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const WS = 'ws-sla-477';
const OR = 'openrouter-video';
const NATIVE = 'gemini-native';
const TEXT = 'gemini-text';

let scratchDir = '';
let scratchFile = '';
let pushError: string | null = null;

try {
  scratchDir = mkdtempSync(join(tmpdir(), 'slashloop-failure-map-'));
  scratchFile = join(scratchDir, 'scratch.sqlite');
  // Resolve the CLI through node_modules rather than the .bin shim so this works
  // on a Windows dev box too. db push --skip-generate: we want the schema on
  // disk, never a rewrite of the committed generated client.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const pushed = Bun.spawnSync([process.execPath, prismaCli, 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.sqlite.prisma'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SQLITE_DB_URL: `file:${scratchFile}` },
  });
  if (pushed.exitCode !== 0) pushError = pushed.stderr.toString().slice(0, 400);
} catch (err) {
  pushError = (err as Error).message;
}

const repoRequire = createRequire(join(REPO_ROOT, 'noop.js'));

/** The production column, over the scratch file. Same two calls as index.ts. */
function makeColumn(url: string): FailureCountsColumn {
  const { PrismaClient } = repoRequire('./src/generated/sqlite/index.js') as
    typeof import('../generated/sqlite/index.js');
  const client = new PrismaClient({ datasources: { db: { url } } });
  return {
    read: async (workspaceId) => {
      const ws = await client.workspace.findUnique({ where: { id: workspaceId }, select: { failureCountsJson: true } });
      return ws?.failureCountsJson ?? null;
    },
    write: async (workspaceId, json) => {
      await client.workspace.update({ where: { id: workspaceId }, data: { failureCountsJson: json } });
    },
  };
}

let col: FailureCountsColumn;

const describeDb = pushError ? describe.skip : describe;

describeDb('failure bookkeeping against a real Workspace row', () => {
  beforeAll(() => {
    col = makeColumn(`file:${scratchFile}`);
  });

  afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * Write the column the way an earlier process would: straight SQL, no Prisma,
   * so the literal on disk is under the test's control and `lastAt` can be
   * stamped in the past without waiting an hour for the decay.
   */
  function seed(failureCountsJson: string, id = WS): void {
    const raw = new Database(scratchFile);
    raw.run('DELETE FROM "Workspace" WHERE id = ?', [id]);
    raw.run(
      'INSERT INTO "Workspace" ("id","failureCountsJson","updatedAt") VALUES (?,?,?)',
      [id, failureCountsJson, new Date().toISOString()],
    );
    raw.close();
  }

  /** The persisted string itself, not a parse of it. */
  function readColumn(id = WS): string {
    const raw = new Database(scratchFile);
    const row = raw.query('SELECT "failureCountsJson" FROM "Workspace" WHERE id = ?').get(id) as
      | { failureCountsJson: string }
      | null;
    raw.close();
    if (!row) throw new Error(`no seeded Workspace row for ${id}`);
    return row.failureCountsJson;
  }

  function readMap(id = WS): FailureMap {
    return JSON.parse(readColumn(id)) as FailureMap;
  }

  /** A second connection over the same file: what the next process would load. */
  function readFromRestartedProcess(id = WS): Promise<FailureMap> {
    return loadFailureMap(makeColumn(`file:${scratchFile}`), id);
  }

  // ---- the park survives a restart ----

  test('a hard failure is parked in the column and still parked after a restart', async () => {
    seed('{}');
    const count = await recordFailure(col, WS, OR, true);

    // The literal that has to be on disk for the next process to see a park.
    const persisted = readMap();
    expect(Object.keys(persisted)).toEqual([OR]);
    expect(persisted[OR]?.hard).toBe(true);
    expect(count).toBeGreaterThanOrEqual(MAX_FAILURES_BEFORE_FALLBACK);

    // A separate connection, not a re-read through the same one: nothing is
    // cached in process, which is the entire reason this state is persisted.
    const afterRestart = await readFromRestartedProcess();
    expect(afterRestart[OR]?.hard).toBe(true);
    expect(afterRestart[OR]?.count).toBeGreaterThanOrEqual(MAX_FAILURES_BEFORE_FALLBACK);
  });

  test('a hard failure lands on the fallback threshold instead of climbing one at a time', async () => {
    seed('{}');
    expect(await recordFailure(col, WS, OR, true)).toBe(MAX_FAILURES_BEFORE_FALLBACK);
    // A second identical 402 must not push the count further: there is no third
    // state to discover, so a growing number would only hide the flag.
    expect(await recordFailure(col, WS, OR, true)).toBe(MAX_FAILURES_BEFORE_FALLBACK);
    expect(readMap()[OR]?.count).toBe(MAX_FAILURES_BEFORE_FALLBACK);
  });

  // ---- the park still expires ----

  test('the decay window still releases a hard park, and keeps a fresh one', async () => {
    seed(JSON.stringify({
      [OR]: { count: 2, lastAt: Date.now() - FAILURE_TTL_MS - 1_000, hard: true },
      [NATIVE]: { count: 1, lastAt: Date.now() - 60_000 },
    }));

    const map = await loadFailureMap(col, WS);
    // An hour-old park lets itself out. That is the release SLA-460 relies on
    // instead of a new lifecycle: nobody has to clear it after a top-up.
    expect(map[OR]).toBeUndefined();
    expect(map[NATIVE]?.count).toBe(1);

    // And a decayed hard flag is not smuggled back in by the next failure on a
    // different backend.
    await recordFailure(col, WS, TEXT);
    expect(readMap()[OR]).toBeUndefined();
    expect(readMap()[TEXT]?.hard).toBeUndefined();
  });

  test('a transient failure on the same backend drops the park flag', async () => {
    seed('{}');
    await recordFailure(col, WS, OR, true);
    expect(readMap()[OR]?.hard).toBe(true);

    const count = await recordFailure(col, WS, OR, false);

    // The backend answered again, so it is no longer an account-level failure:
    // the flag is gone rather than sticky, which is what lets a topped-up
    // OpenRouter key get shot-level analysis again on its own next failure.
    expect('hard' in (readMap()[OR] ?? {})).toBe(false);
    expect(count).toBe(MAX_FAILURES_BEFORE_FALLBACK + 1);
  });

  // ---- recordSuccess is scoped to the backend that succeeded ----

  test('a success on another backend leaves the park in place', async () => {
    seed('{}');
    await recordFailure(col, WS, OR, true);

    // The SLA-460 review's flapping case, inverted: gemini-native answers while
    // the OpenRouter balance is still $0. Before the scoping fix this wiped the
    // whole map, so the next video paid one 402 to re-park the same backend.
    await recordSuccess(col, WS, NATIVE);

    expect(readMap()[OR]?.hard).toBe(true);
    expect((await readFromRestartedProcess())[OR]?.hard).toBe(true);
  });

  test('a success on the parked backend releases the park', async () => {
    seed('{}');
    await recordFailure(col, WS, OR, true);

    // The release path that has to survive: the balance was topped up and
    // openrouter-video itself worked, which is real evidence the account is
    // funded again.
    await recordSuccess(col, WS, OR);

    expect(readMap()[OR]).toBeUndefined();
    expect((await readFromRestartedProcess())[OR]).toBeUndefined();
  });

  test('an unrelated success does not reset another backend count', async () => {
    seed(JSON.stringify({
      [NATIVE]: { count: MAX_FAILURES_BEFORE_FALLBACK, lastAt: Date.now() },
      [TEXT]: { count: 1, lastAt: Date.now() },
    }));

    await recordSuccess(col, WS, TEXT);

    // Same class of surprise as the park: the primary's two-strike record used
    // to be erased by the fallback succeeding, which put the workspace straight
    // back on the backend that had just failed twice.
    expect(readMap()[NATIVE]?.count).toBe(MAX_FAILURES_BEFORE_FALLBACK);
    expect(readMap()[TEXT]).toBeUndefined();
  });

  test('a success compacts already-decayed entries instead of stranding them', async () => {
    seed(JSON.stringify({
      [TEXT]: { count: 1, lastAt: Date.now() - FAILURE_TTL_MS - 1_000 },
      [OR]: { count: 2, lastAt: Date.now(), hard: true },
    }));

    await recordSuccess(col, WS, NATIVE);

    // loadFailureMap filters the decayed entry out of every read, but only a
    // write shrinks the column. Unconditional write, same write count as the
    // old whole-map clear.
    const persisted = readMap();
    expect(persisted[TEXT]).toBeUndefined();
    expect(persisted[OR]?.hard).toBe(true);
  });

  // ---- the read is total ----

  test('an unparsable column reads as no history, and the next failure rewrites it', async () => {
    seed('{"openrouter-video": {count:');

    expect(await loadFailureMap(col, WS)).toEqual({});

    await recordFailure(col, WS, NATIVE);

    // A truncated write must not wedge the workspace permanently — the next
    // failure replaces the junk with valid JSON.
    expect(JSON.parse(readColumn())[NATIVE]?.count).toBe(1);
  });

  test('a workspace that never failed reads as an empty map', async () => {
    seed('{}');
    expect(await loadFailureMap(col, WS)).toEqual({});
    expect(await loadFailureMap(col, 'ws-sla-477-absent')).toEqual({});
  });
});

if (pushError) {
  // Loud, not silent: a skipped DB fixture nobody notices is the same gap this
  // file was opened to close.
  console.warn(`[failure-bookkeeping] scratch DB unavailable, DB-backed cases skipped: ${pushError}`);
}