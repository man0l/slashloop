// Endpoint-level tests for the experiments API: paginated listing and the
// bulk DELETE cascade (per-id best-effort, running experiments refused).
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ExperimentError } from '../src/experiments/schema.js';

const experiments = new Map<string, any>();
const deletedObjects: string[] = [];

// Snapshot by value: Bun patches a loaded module's exports in place when it is mocked.
const realStore = { ...(await import('../src/experiments/store.js')) };
mock.module('../src/experiments/store.js', () => ({
  ...realStore,
  load: async (_ws: string, id: string) => {
    const e = experiments.get(id);
    if (!e) throw new ExperimentError(404, 'experiment_not_found');
    return structuredClone(e);
  },
  list: async (_ws: string, limit = 50, offset = 0, ranBy?: string | null) => {
    const all = [...experiments.values()].filter(e => !ranBy || e.ranBy === ranBy).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return all.slice(offset, offset + limit);
  },
  remove: async (_ws: string, id: string) => {
    const had = experiments.has(id);
    if (had) experiments.delete(id);
    return had;
  },
  serialize: (e: any) => ({ ...e, serialized: true }),
}));
const realStorage = { ...(await import('../src/lib/storage.js')) };
mock.module('../src/lib/storage.js', () => ({
  ...realStorage,
  deleteObjects: async (_bucket: string, paths: string[]) => { deletedObjects.push(...paths); return paths.length; },
  thumbBucket: () => 'thumbs',
}));
const realAuthz = { ...(await import('../src/lib/authz.js')) };
mock.module('../src/lib/authz.js', () => ({
  ...realAuthz,
  requireWorkspaceAccess: async () => ({ ok: true }),
}));

const { DELETE, GET } = await import('./experiments.js');

// mock.module is process-global: hand later files the real modules back by value, serializer included.
afterAll(() => {
  mock.module('../src/experiments/store.js', () => ({ ...realStore }));
  mock.module('../src/lib/storage.js', () => ({ ...realStorage }));
  mock.module('../src/lib/authz.js', () => ({ ...realAuthz }));
});

function exp(id: string, status = 'done', slidePaths: string[] = []) {
  return {
    id, workspaceId: 'w', status, version: 0, createdAt: '2026-09-19', updatedAt: '2026-09-19',
    instructions: { goal: id }, variantCount: 1, slideCount: slidePaths.length || 2, maxCredits: 100, creditsCharged: 5,
    report: null, inputs: [], error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    tasks: [], commands: {}, allowPartial: false, createFingerprint: 'x',
    variants: [{ id: `v-${id}`, slides: slidePaths.map((p, i) => ({ index: i, status: 'done', path: p, url: `https://cdn/${p}` })) }],
  };
}
function req(method: string, url: string, body?: unknown) {
  return new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' } });
}

beforeEach(() => { experiments.clear(); deletedObjects.length = 0; });

describe('experiments endpoint', () => {
  test('bulk DELETE cascades rows and R2 paths and reports per-id failures', async () => {
    experiments.set('done1', exp('done1', 'done', ['w/e1/r1/a.jpg', 'w/e1/r1/b.jpg']));
    experiments.set('running', exp('running', 'generating'));
    // 'gone' is intentionally absent: unknown ids fail without aborting the batch.
    const res = await DELETE(req('DELETE', 'https://x.test/api/experiments', { workspaceId: 'w', ids: ['done1', 'running', 'gone'] }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe(1);
    expect(body.failed.map((f: any) => ({ id: f.id, code: f.code }))).toEqual([
      { id: 'running', code: 'active_experiment' },
      { id: 'gone', code: 'experiment_not_found' },
    ]);
    expect(experiments.has('done1')).toBe(false);
    expect(experiments.has('running')).toBe(true);
    // Only the deleted experiment's retained images are removed.
    expect(deletedObjects).toEqual(['w/e1/r1/a.jpg', 'w/e1/r1/b.jpg']);
  });

  test('bulk DELETE rejects an empty id list', async () => {
    const res = await DELETE(req('DELETE', 'https://x.test/api/experiments', { workspaceId: 'w', ids: [] }));
    expect(res.status).toBe(400);
  });

  test('GET list paginates with nextOffset and serializes rows', async () => {
    for (let i = 1; i <= 5; i++) experiments.set(`e${i}`, { ...exp(`e${i}`), createdAt: `2026-09-0${i}` });
    const page1 = await (await GET(req('GET', 'https://x.test/api/experiments?workspaceId=w&limit=2&offset=0'))).json() as any;
    expect(page1.experiments.map((e: any) => e.id)).toEqual(['e1', 'e2']);
    expect(page1.nextOffset).toBe(2);
    expect(page1.experiments[0].serialized).toBe(true);
    const page3 = await (await GET(req('GET', 'https://x.test/api/experiments?workspaceId=w&limit=2&offset=4'))).json() as any;
    expect(page3.experiments.map((e: any) => e.id)).toEqual(['e5']);
    expect(page3.nextOffset).toBeNull();
  });

  test('GET list filters by ran_by, exposes ranBy, and keeps nextOffset', async () => {
    const LEO = 'agent:Leo';
    for (let i = 1; i <= 3; i++) experiments.set(`l${i}`, { ...exp(`l${i}`), createdAt: `2026-09-0${i}`, ranBy: LEO });
    experiments.set('u1', { ...exp('u1'), createdAt: '2026-09-09', ranBy: 'user' });
    experiments.set('n1', { ...exp('n1'), createdAt: '2026-09-10', ranBy: null });
    const url = `https://x.test/api/experiments?workspaceId=w&limit=2&ran_by=${encodeURIComponent(LEO)}`;
    const page1 = await (await GET(req('GET', url))).json() as any;
    expect(page1.experiments.map((e: any) => [e.id, e.ranBy])).toEqual([['l1', LEO], ['l2', LEO]]);
    expect(page1.nextOffset).toBe(2);
    const page2 = await (await GET(req('GET', `${url}&offset=2`))).json() as any;
    expect(page2.experiments.map((e: any) => e.id)).toEqual(['l3']);
    expect(page2.nextOffset).toBeNull();
    const unfiltered = await (await GET(req('GET', 'https://x.test/api/experiments?workspaceId=w&limit=50'))).json() as any;
    expect(unfiltered.experiments).toHaveLength(5);
  });
});
