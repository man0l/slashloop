// Public gallery link (SLA-1093): owner-only mint/revoke, and the anonymous
// ?publicToken= branch of /api/gallery-data (hit, miss, no widening).
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type WsRow = { id: string; name: string; ownerId: string | null; publicToken: string | null };
let rows: WsRow[] = [];
let authUser: string | null = 'owner-1';
const cardCalls: Array<{ workspaceId: string; opts: Record<string, unknown> }> = [];

// Everything heavy is loaded inside beforeAll, not at file top level: bun
// evaluates every test file's top level before running any test, and loading
// the real api/gallery.js graph that early would pre-empt the module mocks in
// api/experiments.test.ts. The fakes are put back in afterAll for the same reason.
let workspacesApi: typeof import('./workspaces.js');
let galleryApi: { GET: (r: Request) => Promise<Response> };
let findWorkspaceByPublicToken: typeof import('../src/lib/workspaces.js').findWorkspaceByPublicToken;
let restore: Array<() => void> = [];

beforeAll(async () => {
  const realDb = { ...(await import('../src/db.js')) };
  const realAuthz = { ...(await import('../src/lib/authz.js')) };
  const realGallery = { ...(await import('../src/tools/gallery.js')) };
  restore = [
    () => mock.module('../src/db.js', () => realDb),
    () => mock.module('../src/lib/authz.js', () => realAuthz),
    () => mock.module('../src/tools/gallery.js', () => realGallery),
  ];
  mock.module('../src/db.js', () => ({
    ...realDb,
    db: {
      workspace: {
        findFirst: async ({ where }: { where: Partial<WsRow> }) =>
          rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<WsRow> }) => {
          const r = rows.find((x) => x.id === where.id)!;
          Object.assign(r, data);
          return r;
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
    requireWorkspaceAccess: async (request: Request) => ({
      ok: false,
      response: realAuthz.jsonResponse(401, { error: 'invalid_token' }, request),
    }),
  }));
  mock.module('../src/tools/gallery.js', () => ({
    ...realGallery,
    buildCardsForWorkspace: async (ws: { id: string }, opts: Record<string, unknown>) => {
      cardCalls.push({ workspaceId: ws.id, opts });
      return { cards: [{ id: 'v1' }], note: 'Filtered to source s-1.', filters: { sortBy: 'outlier_score' } };
    },
  }));
  workspacesApi = await import('./workspaces.js');
  const { handlePublicGalleryData } = await import('../src/lib/public-gallery.js');
  // api/gallery.ts's ?publicToken= dispatch, minus its heavy import graph.
  galleryApi = {
    GET: async (request) => {
      const url = new URL(request.url);
      return handlePublicGalleryData(request, url, url.searchParams.get('publicToken') ?? '');
    },
  };
  ({ findWorkspaceByPublicToken } = await import('../src/lib/workspaces.js'));
});
afterAll(() => {
  for (const r of restore) r();
});

const req = (path: string, method = 'GET') => new Request(`https://mcp.slashloop.dev${path}`, { method });
const TOKEN = 'A'.repeat(43);

beforeEach(() => {
  rows = [
    { id: 'ws-1', name: 'Acme', ownerId: 'owner-1', publicToken: null },
    { id: 'ws-2', name: 'Other', ownerId: 'someone-else', publicToken: TOKEN },
  ];
  authUser = 'owner-1';
  cardCalls.length = 0;
});

describe('POST/DELETE /api/workspaces/:id/public-link', () => {
  test('owner mints a 43-char base64url token and gets the site URL; second call is idempotent', async () => {
    const res = await workspacesApi.POST(req('/api/workspaces?id=ws-1&resource=public-link', 'POST'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`https://slashloop.dev/s/${body.token}`);
    expect(rows[0].publicToken).toBe(body.token);

    const again = (await (await workspacesApi.POST(req('/api/workspaces?id=ws-1&resource=public-link', 'POST'))).json()) as { token: string };
    expect(again.token).toBe(body.token);
  });

  test('a non-owner cannot mint or revoke (404, token untouched)', async () => {
    const mint = await workspacesApi.POST(req('/api/workspaces?id=ws-2&resource=public-link', 'POST'));
    expect(mint.status).toBe(404);
    const stop = await workspacesApi.DELETE(req('/api/workspaces?id=ws-2&resource=public-link', 'DELETE'));
    expect(stop.status).toBe(404);
    expect(rows[1].publicToken).toBe(TOKEN);
  });

  test('unauthenticated -> 401', async () => {
    authUser = null;
    const res = await workspacesApi.POST(req('/api/workspaces?id=ws-1&resource=public-link', 'POST'));
    expect(res.status).toBe(401);
  });

  test('DELETE clears the token and the old URL stops resolving', async () => {
    rows[0].publicToken = 'B'.repeat(43);
    const res = await workspacesApi.DELETE(req('/api/workspaces?id=ws-1&resource=public-link', 'DELETE'));
    expect(res.status).toBe(200);
    expect(rows[0].publicToken).toBeNull();
    const data = await galleryApi.GET(req(`/api/gallery-data?mode=data&publicToken=${'B'.repeat(43)}`));
    expect(data.status).toBe(404);
  });
});

describe('GET /api/gallery-data?publicToken=', () => {
  test('token hit returns workspace name + cards with no bearer, and no note', async () => {
    const res = await galleryApi.GET(req(`/api/gallery-data?mode=data&publicToken=${TOKEN}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceName).toBe('Other');
    expect(body.cards).toEqual([{ id: 'v1' }]);
    expect(body).not.toHaveProperty('note');
    expect(cardCalls[0].workspaceId).toBe('ws-2');
  });

  test('token miss and malformed token -> 404', async () => {
    const miss = await galleryApi.GET(req(`/api/gallery-data?mode=data&publicToken=${'Z'.repeat(43)}`));
    expect(miss.status).toBe(404);
    const bad = await galleryApi.GET(req('/api/gallery-data?mode=data&publicToken=short'));
    expect(bad.status).toBe(404);
    expect(cardCalls).toHaveLength(0);
  });

  test('query params cannot widen the view: workspaceId/sourceId/videoId/creatorHandle ignored, limit pinned', async () => {
    const res = await galleryApi.GET(
      req(`/api/gallery-data?mode=data&publicToken=${TOKEN}&workspaceId=ws-1&sourceId=s-9&videoId=v-9&creatorHandle=bob&analyzedBy=openrouter&limit=500&minViews=100`),
    );
    expect(res.status).toBe(200);
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0].workspaceId).toBe('ws-2');
    expect(cardCalls[0].opts).toEqual({ sortBy: 'outlier_score', limit: 48, minOutlier: undefined, minViews: 100 });
  });
});

describe('findWorkspaceByPublicToken', () => {
  test('null / malformed never match', async () => {
    expect(await findWorkspaceByPublicToken(null)).toBeNull();
    expect(await findWorkspaceByPublicToken('x')).toBeNull();
    expect((await findWorkspaceByPublicToken(TOKEN))?.id).toBe('ws-2');
  });
});
