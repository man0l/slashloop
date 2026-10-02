// Endpoint-level tests for the experiments API: paginated listing and the
// bulk DELETE cascade (per-id best-effort, running experiments refused).
//
// The store and the storage backend come in through their seams
// (swapActiveClientForTests + DB_DIALECT=sqlite over an in-memory table, and
// setR2Bindings) instead of `mock.module`. `mock.module` rewrites the module
// registry that every file in a `bun test` run shares and Bun cannot undo it, so
// this file's fake experiments store used to reach every other experiments test
// in the run. See docs/test-suite-policy.md.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { swapActiveClientForTests, type AppPrismaClient, type RawStatement } from '../src/store.js';
import { setR2Bindings } from '../src/lib/storage-bindings.js';

const savedDialect = process.env.DB_DIALECT;

const sql = new Database(':memory:');
sql.exec(`CREATE TABLE "Experiment" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "status" TEXT,
  "version" INTEGER, "dataJson" TEXT, "createdAt" TEXT, "updatedAt" TEXT, "createKey" TEXT);`);

const raw = async (statements: RawStatement[]) => {
  const out: unknown[][] = [];
  for (const s of statements) {
    out.push(sql.query(s.sql).all(...(s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as never[]));
  }
  return out;
};

const deletedObjects: string[] = [];
let restoreStore = () => {};
beforeAll(() => {
  // Installed at test time, not while this file loads: `bun test` evaluates
  // every file before running any of them, so a module-scope fake can be
  // displaced by a file that loads later.
  restoreStore = swapActiveClientForTests({} as unknown as AppPrismaClient, raw);
  process.env.DB_DIALECT = 'sqlite';
  setR2Bindings({
    thumbs: { delete: async (paths: string[]) => { deletedObjects.push(...paths); } },
    media: { delete: async () => {} },
  } as unknown as Parameters<typeof setR2Bindings>[0]);
});
afterAll(() => {
  restoreStore();
  if (savedDialect === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = savedDialect;
  setR2Bindings(null as unknown as Parameters<typeof setR2Bindings>[0]);
});

// The endpoint is authorised by the bearer token, not by a workspace row: keep
// the authz fake (there is no seam for a Supabase JWT) and stub nothing else.
const realAuthz = await import('../src/lib/authz.js');
mock.module('../src/lib/authz.js', () => ({
  ...realAuthz,
  requireWorkspaceAccess: async () => ({ ok: true }),
}));

const { DELETE, GET } = await import('./experiments.js');

function exp(id: string, status = 'done', slidePaths: string[] = []) {
  return {
    id, workspaceId: 'w', status, version: 0, createdAt: '2026-09-19', updatedAt: '2026-09-19',
    instructions: { goal: id }, variantCount: 1, slideCount: slidePaths.length || 2, maxCredits: 100, creditsCharged: 5,
    report: null, inputs: [], error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    tasks: [], commands: {}, allowPartial: false, createFingerprint: 'x',
    variants: [{ id: `v-${id}`, slides: slidePaths.map((p, i) => ({ index: i, status: 'done', path: p, url: `https://cdn/${p}` })) }],
  };
}
/** Seed through SQL so the real store's own ordering and CAS are what runs. */
function seed(id: string, over: Record<string, unknown> = {}) {
  const e = { ...exp(id), ...over } as Record<string, unknown>;
  sql.run(`INSERT INTO "Experiment" ("id","workspaceId","status","version","dataJson","createdAt","updatedAt","createKey")
    VALUES (?,?,?,0,?,?,?,?)`, [e.id, e.workspaceId, e.status, JSON.stringify(e), e.createdAt, e.updatedAt, `seed-${id}`]);
  return e;
}
function req(method: string, url: string, body?: unknown) {
  return new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' } });
}

beforeEach(() => { sql.exec('DELETE FROM "Experiment"'); deletedObjects.length = 0; });

describe('experiments endpoint', () => {
  test('bulk DELETE cascades rows and R2 paths and reports per-id failures', async () => {
    seed('done1', { status: 'done', variants: [{ id: 'v-done1', slides: [{ index: 0, status: 'done', path: 'w/e1/r1/a.jpg', url: 'https://cdn/a' }, { index: 1, status: 'done', path: 'w/e1/r1/b.jpg', url: 'https://cdn/b' }] }] });
    seed('running', { status: 'generating' });
    // 'gone' is intentionally absent: unknown ids fail without aborting the batch.
    const res = await DELETE(req('DELETE', 'https://x.test/api/experiments', { workspaceId: 'w', ids: ['done1', 'running', 'gone'] }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe(1);
    expect(body.failed.map((f: any) => ({ id: f.id, code: f.code }))).toEqual([
      { id: 'running', code: 'active_experiment' },
      { id: 'gone', code: 'experiment_not_found' },
    ]);
    expect(sql.query('SELECT "id" FROM "Experiment" WHERE "id" = ?').all('done1')).toEqual([]);
    expect(sql.query('SELECT "id" FROM "Experiment" WHERE "id" = ?').all('running')).toHaveLength(1);
    // Only the deleted experiment's retained images are removed.
    expect(deletedObjects).toEqual(['w/e1/r1/a.jpg', 'w/e1/r1/b.jpg']);
  });

  test('bulk DELETE rejects an empty id list', async () => {
    const res = await DELETE(req('DELETE', 'https://x.test/api/experiments', { workspaceId: 'w', ids: [] }));
    expect(res.status).toBe(400);
  });

  test('GET list paginates newest first with nextOffset and serializes rows', async () => {
    for (let i = 1; i <= 5; i++) seed(`e${i}`, { createdAt: `2026-09-0${i}` });
    const page1 = await (await GET(req('GET', 'https://x.test/api/experiments?workspaceId=w&limit=2&offset=0'))).json() as any;
    expect(page1.experiments.map((e: any) => e.id)).toEqual(['e5', 'e4']);
    expect(page1.nextOffset).toBe(2);
    // The real serializer: per-job projection plus the provider budget.
    expect(page1.experiments[0].jobs).toEqual([]);
    expect(page1.experiments[0].providerBudget).toMatchObject({ exactUsdCap: false });
    const page3 = await (await GET(req('GET', 'https://x.test/api/experiments?workspaceId=w&limit=2&offset=4'))).json() as any;
    expect(page3.experiments.map((e: any) => e.id)).toEqual(['e1']);
    expect(page3.nextOffset).toBeNull();
  });
});