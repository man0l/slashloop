// SLA-615: Experiment.ranBy — who ran an experiment ("user" or
// "agent:<name> on behalf of <user>"). A real indexed column so "everything this
// runner ran" is a seek. These tests run the real store against a bun:sqlite
// database built from the real D1 migrations, so the migration, the column, the
// filter and the index are all exercised together.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Video } from '@prisma/client';
import type { RawStatement } from '../store.js';
import * as realStore from './store.js';
import { createExperiment, type CreateExperimentDeps } from './service.js';
import { normalizeRanBy, RAN_BY_MAX, takeRanBy, type Experiment } from './schema.js';

const migration = (name: string) => readFileSync(new URL(`../../prisma/d1-migrations/${name}`, import.meta.url), 'utf8');

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(migration('0008_experiments.sql'));
  db.exec(migration('0016_experiment_ran_by.sql'));
  db.exec(migration('0017_experiment_webhook_outbox.sql'));
});
// The real store functions over a real SQLite database; no process-global state.
const run = async (statements: RawStatement[]) => statements.map(s => (
  db.query(s.sql).all(...((s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as any[]))
));
const create = (e: Experiment, key: string) => realStore.create(e, key, run);
const load = (ws: string, id: string) => realStore.load(ws, id, run);
const list = (ws: string, limit?: number, offset?: number, ranBy?: string | null) => realStore.list(ws, limit, offset, ranBy, run);

function exp(id: string, createdAt: string, over: Partial<Experiment> = {}): Experiment {
  return {
    id, workspaceId: 'w1', status: 'draft', createdAt, updatedAt: createdAt,
    instructions: { goal: id, brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 0, report: null, inputs: [], variants: [], error: null,
    generationBasis: 'text-directed', assetPolicy: 'retained', version: 0, tasks: [], commands: {}, allowPartial: false, createFingerprint: `fp-${id}`,
    ...over,
  };
}
const ids = (rows: Experiment[]) => rows.map(r => r.id);
const LEO = 'agent:Leo on behalf of man0l';

describe('normalizeRanBy / takeRanBy', () => {
  test('trims, caps, and maps blank or non-string to null', () => {
    expect(normalizeRanBy('  user  ')).toBe('user');
    expect(normalizeRanBy('')).toBeNull();
    expect(normalizeRanBy('   ')).toBeNull();
    expect(normalizeRanBy(undefined)).toBeNull();
    expect(normalizeRanBy(42)).toBeNull();
    expect(normalizeRanBy('x'.repeat(500))).toBe('x'.repeat(RAN_BY_MAX));
  });

  test('takeRanBy accepts ran_by or ranBy and strips both from the body', () => {
    expect(takeRanBy({ a: 1, ran_by: ' user ' })).toEqual({ body: { a: 1 }, ranBy: 'user' });
    expect(takeRanBy({ a: 1, ranBy: LEO })).toEqual({ body: { a: 1 }, ranBy: LEO });
    expect(takeRanBy({ a: 1 })).toEqual({ body: { a: 1 }, ranBy: null });
  });
});

describe('store', () => {
  test('the migration adds a nullable column and the (workspaceId, ranBy, createdAt) index', () => {
    const cols = db.query(`PRAGMA table_info("Experiment")`).all() as Array<{ name: string; notnull: number }>;
    expect(cols.find(c => c.name === 'ranBy')).toMatchObject({ notnull: 0 });
    const index = db.query(`PRAGMA index_info("Experiment_workspaceId_ranBy_createdAt_idx")`).all() as Array<{ name: string }>;
    expect(index.map(i => i.name)).toEqual(['workspaceId', 'ranBy', 'createdAt']);
  });

  test('ranBy round-trips through create, load and list; legacy rows read back null', async () => {
    await create(exp('e1', '2026-10-01T00:00:00Z', { ranBy: LEO }), 'k1');
    await create(exp('e2', '2026-10-02T00:00:00Z'), 'k2');
    db.run(`INSERT INTO "Experiment" ("id","workspaceId","status","version","dataJson","createdAt","updatedAt","createKey") VALUES ('legacy','w1','draft',0,?, '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','k0')`, [JSON.stringify(exp('legacy', '2026-09-01T00:00:00Z'))]);
    expect((await load('w1', 'e1')).ranBy).toBe(LEO);
    expect((await load('w1', 'e2')).ranBy).toBeNull();
    expect((await load('w1', 'legacy')).ranBy).toBeNull();
    expect((await list('w1')).map(r => [r.id, r.ranBy])).toEqual([['e2', null], ['e1', LEO], ['legacy', null]]);
  });

  test('the filter is an exact, workspace-scoped match', async () => {
    await create(exp('a', '2026-10-01T00:00:00Z', { ranBy: LEO }), 'ka');
    await create(exp('b', '2026-10-02T00:00:00Z', { ranBy: 'user' }), 'kb');
    await create(exp('c', '2026-10-03T00:00:00Z', { ranBy: LEO }), 'kc');
    await create(exp('d', '2026-10-04T00:00:00Z'), 'kd');
    await create(exp('other-ws', '2026-10-05T00:00:00Z', { workspaceId: 'w2', ranBy: LEO }), 'ke');
    expect(ids(await list('w1', 50, 0, LEO))).toEqual(['c', 'a']);
    expect(ids(await list('w1', 50, 0, 'user'))).toEqual(['b']);
    expect(ids(await list('w1', 50, 0, 'agent:Leo'))).toEqual([]);
    expect(ids(await list('w1', 50, 0, 'USER'))).toEqual([]);
    expect(ids(await list('w1', 50, 0, `  ${LEO}  `))).toEqual(['c', 'a']);
    expect(ids(await list('w1', 50, 0, ''))).toEqual(['d', 'c', 'b', 'a']);
    expect(ids(await list('w1'))).toEqual(['d', 'c', 'b', 'a']);
  });

  test('pagination keeps working under the filter (limit+1 reveals the next page)', async () => {
    for (let i = 1; i <= 5; i++) await create(exp(`m${i}`, `2026-10-0${i}T00:00:00Z`, { ranBy: LEO }), `km${i}`);
    await create(exp('noise', '2026-10-06T00:00:00Z', { ranBy: 'user' }), 'kn');
    expect(ids(await list('w1', 3, 0, LEO))).toEqual(['m5', 'm4', 'm3']);
    expect(ids(await list('w1', 3, 2, LEO))).toEqual(['m3', 'm2', 'm1']);
    expect(ids(await list('w1', 3, 3, LEO))).toEqual(['m2', 'm1']);
  });

  test('the filtered read is an index seek with no temp sort', () => {
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT "dataJson","ranBy" FROM "Experiment" WHERE "workspaceId" = ? AND "ranBy" = ? ORDER BY "createdAt" DESC LIMIT ? OFFSET ?`)
      .all('w1', LEO, 10, 0) as Array<{ detail: string }>;
    const detail = plan.map(p => p.detail).join('\n');
    expect(detail).toContain('Experiment_workspaceId_ranBy_createdAt_idx');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('an idempotent replay returns the first row and keeps its original runner', async () => {
    await create(exp('first', '2026-10-01T00:00:00Z', { ranBy: LEO, createFingerprint: 'same' }), 'k');
    const replay = await create(exp('second', '2026-10-02T00:00:00Z', { ranBy: 'user', createFingerprint: 'same' }), 'k');
    expect(replay).toMatchObject({ id: 'first', ranBy: LEO });
  });
});

describe('createExperiment', () => {
  const source = { id: 'vid1', rawJson: JSON.stringify({ slideshowKeys: ['s0', 's1', 's2'] }), durationSec: 10, mediaStatus: 'slideshow', thumbnailUrl: null, creatorHandle: '@x', caption: 'c', views: 1 } as unknown as Video;
  const persisted: Experiment[] = [];
  const deps: CreateExperimentDeps = {
    findSource: async () => source,
    findLatestAnalysis: async () => null,
    buildInput: async v => ({ videoId: v.id, status: 'ready', analysisId: null, jobId: null, error: null, coverage: null, evidence: [] }),
    persist: async e => { persisted.push(e); return e; },
  };
  const body = { workspaceId: 'w1', videoIds: ['vid1'], instructions: { goal: 'Find a hook', brand: '', audience: '', language: 'English', variables: ['hook'] }, variantCount: 3, slideCount: 3, maxCredits: 200, idempotencyKey: 'key-12345678' };

  test('ran_by is normalised onto the experiment and stays out of the idempotency fingerprint', async () => {
    persisted.length = 0;
    await createExperiment({ ...body, ran_by: `  ${LEO}  ` }, deps);
    await createExperiment({ ...body, ran_by: 'user' }, deps);
    await createExperiment(body, deps);
    await createExperiment({ ...body, ran_by: '   ' }, deps);
    expect(persisted.map(e => e.ranBy)).toEqual([LEO, 'user', null, null]);
    expect(new Set(persisted.map(e => e.createFingerprint)).size).toBe(1);
  });
});
