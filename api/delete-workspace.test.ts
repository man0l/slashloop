// Workspace deletion (SLA-1223): DELETE /api/workspaces/:id is owner-only,
// refuses the primary (billing) workspace and running experiments, and
// removes every workspace-keyed table child-first with the Workspace row last.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type WsRow = { id: string; ownerId: string; createdAt: Date };
let rows: WsRow[] = [];
let runningExperiments = 0;
let authUser: string | null = 'owner-1';
let calls: Array<{ model: string; op: string; where: unknown }> = [];

// Loaded in beforeAll and restored in afterAll — see api/public-link.test.ts.
let workspacesApi: typeof import('./workspaces.js');
let restore: Array<() => void> = [];

const matches = (r: WsRow, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);

function model(name: string) {
  return {
    count: async ({ where }: { where: { status?: unknown } }) => {
      calls.push({ model: name, op: 'count', where });
      if (name === 'experiment' && where.status) return runningExperiments;
      return 3;
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      calls.push({ model: name, op: 'deleteMany', where });
      return { count: 2 };
    },
  };
}

beforeAll(async () => {
  const realDb = { ...(await import('../src/db.js')) };
  const realAuthz = { ...(await import('../src/lib/authz.js')) };
  restore = [
    () => mock.module('../src/db.js', () => realDb),
    () => mock.module('../src/lib/authz.js', () => realAuthz),
  ];
  const models = Object.fromEntries(
    ['brief', 'script', 'hook', 'swipeEntry', 'idea', 'analysis', 'score', 'mediaJob', 'refreshRun', 'video', 'source',
      'board', 'experiment', 'experimentWebhookOutbox', 'faceLibrary', 'usageLog', 'creditLedger', 'autoAnalyzeRun',
      'suggestionDismissal', 'workspaceMember'].map((n) => [n, model(n)]),
  );
  mock.module('../src/db.js', () => ({
    ...realDb,
    db: {
      ...models,
      workspace: {
        findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
          const hits = rows.filter((r) => matches(r, where));
          if (orderBy) hits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return hits[0] ?? null;
        },
        delete: async ({ where }: { where: { id: string } }) => {
          calls.push({ model: 'workspace', op: 'delete', where });
          rows = rows.filter((r) => r.id !== where.id);
          return {};
        },
      },
    },
  }));
  mock.module('../src/lib/authz.js', () => ({
    ...realAuthz,
    requireAuth: async (request: Request) =>
      authUser
        ? { ok: true, userId: authUser, email: 'o@x.co' }
        : { ok: false, response: realAuthz.jsonResponse(401, { error: 'invalid_token' }, request) },
  }));
  workspacesApi = await import('./workspaces.js');
});

afterAll(() => {
  for (const r of restore) r();
});

beforeEach(() => {
  rows = [
    { id: 'ws-primary', ownerId: 'owner-1', createdAt: new Date('2026-01-01') },
    { id: 'ws-client', ownerId: 'owner-1', createdAt: new Date('2026-05-01') },
    { id: 'ws-other', ownerId: 'owner-2', createdAt: new Date('2026-02-01') },
  ];
  runningExperiments = 0;
  authUser = 'owner-1';
  calls = [];
});

const del = (id: string) =>
  workspacesApi.DELETE(new Request(`https://x.test/api/workspaces/${id}?id=${id}`, { method: 'DELETE' }));

describe('DELETE /api/workspaces/:id', () => {
  test('requires auth', async () => {
    authUser = null;
    expect((await del('ws-client')).status).toBe(401);
  });

  test("404s on someone else's workspace and deletes nothing", async () => {
    const res = await del('ws-other');
    expect(res.status).toBe(404);
    expect(calls.filter((c) => c.op !== 'count')).toEqual([]);
  });

  test('refuses the primary (billing) workspace', async () => {
    const res = await del('ws-primary');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('primary_workspace');
    expect(rows.some((r) => r.id === 'ws-primary')).toBe(true);
  });

  test('refuses while an experiment is running', async () => {
    runningExperiments = 1;
    const res = await del('ws-client');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('active_experiments');
    expect(calls.some((c) => c.op === 'deleteMany')).toBe(false);
  });

  test('cascades every workspace table child-first, Workspace row last', async () => {
    const res = await del('ws-client');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, id: 'ws-client', sources: 3, videos: 3, experiments: 2, usageLogs: 2 });

    const order = calls.filter((c) => c.op !== 'count').map((c) => c.model);
    expect(order.at(-1)).toBe('workspace');
    const before = (a: string, b: string) => expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before('brief', 'idea');
    before('brief', 'analysis');
    before('script', 'analysis');
    before('hook', 'analysis');
    before('swipeEntry', 'board');
    before('score', 'video');
    before('mediaJob', 'video');
    before('refreshRun', 'source');
    before('video', 'source');
    for (const m of ['usageLog', 'creditLedger', 'experiment', 'faceLibrary', 'workspaceMember', 'suggestionDismissal', 'autoAnalyzeRun']) {
      expect(order).toContain(m);
    }
    // Every delete is scoped to this workspace — nothing unscoped.
    for (const c of calls.filter((x) => x.op !== 'count')) expect(JSON.stringify(c.where)).toContain('ws-client');
    expect(rows.map((r) => r.id)).toEqual(['ws-primary', 'ws-other']);
  });
});
