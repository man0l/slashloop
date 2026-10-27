import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { normalizeHandle } from '../lib/tools-handle.js';
import { producerSignature, type PublishBody } from '../queue/producer.js';
import {
  DAILY_HANDLE_LIMIT,
  DAILY_IP_LIMIT,
  DAILY_VIDEO_IP_LIMIT,
  DAILY_VIDEO_LIMIT,
  RESULT_PATH,
  handleLookupGet,
  handleLookupPost,
  handleResultCallback,
  type ToolsLookupDeps,
} from './tools-lookup.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const SECRET = 'cb-secret';
const BASE = 'https://mcp.slashloop.dev';

interface Row {
  id: string;
  kind: string;
  subject: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  client_hash?: string;
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string | { type?: string }) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' || (typeof type === 'object' && type.type === 'json') ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function fakeDb() {
  const rows: Row[] = [];
  const db = {
    rows,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          if (sql.startsWith('SELECT id FROM tools_lookups') && sql.includes('created_at >')) {
            const [kind, subject, since] = args as string[];
            return rows.find((r) => r.kind === kind && r.subject === subject && r.status === 'queued' && r.created_at > since) ?? null;
          }
          if (sql.startsWith('SELECT id FROM tools_lookups') && sql.includes('id !=')) {
            const [kind, subject, id] = args as string[];
            return rows.find((r) => r.kind === kind && r.subject === subject && r.status === 'queued' && r.id !== id) ?? null;
          }
          if (sql.startsWith('SELECT COUNT(*) AS n FROM tools_lookups')) {
            const [hash, since] = args as string[];
            return { n: rows.filter((r) => r.client_hash === hash && r.created_at > since).length };
          }
          if (sql.startsWith('SELECT id, status, result_json')) return rows.find((r) => r.id === args[0]) ?? null;
          if (sql.startsWith('SELECT subject, status')) return rows.find((r) => r.id === args[0]) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith('INSERT INTO tools_lookups')) {
            const [id, kind, subject, created, , client_hash] = args as string[];
            rows.push({ id, kind, subject, status: 'queued', result_json: null, error_code: null, created_at: created, client_hash });
          } else if (sql.includes("SET status = 'failed'")) {
            const row = rows.find((r) => r.id === args[2])!;
            row.status = 'failed';
            row.error_code = args[0] as string;
          } else if (sql.includes("SET status = 'done'")) {
            const row = rows.find((r) => r.id === args[2])!;
            row.status = 'done';
            row.result_json = args[0] as string;
          } else if (sql.startsWith('DELETE FROM tools_lookups')) {
            const i = rows.findIndex((r) => r.id === args[0]);
            if (i >= 0) rows.splice(i, 1);
          } else throw new Error(`unexpected run(): ${sql}`);
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { rows: Row[] };
}

let realFetch: typeof fetch;
let turnstileOk = true;
let turnstileCalls = 0;
function stubTurnstile() {
  turnstileCalls = 0;
  globalThis.fetch = (async () => {
    turnstileCalls++;
    return new Response(JSON.stringify({ success: turnstileOk }), { status: 200 });
  }) as unknown as typeof fetch;
}
beforeEach(() => {
  realFetch = globalThis.fetch;
  turnstileOk = true;
  stubTurnstile();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    DB_SHARD0: fakeDb(),
    OAUTH_KV: fakeKv(),
    TURNSTILE_SECRET: 'ts',
    TOOLS_CALLBACK_SECRET: SECRET,
    TOOLS_WORKSPACE_ID: 'ws-tools',
    QUEUE_API_URL: 'https://queue.example.test',
    QUEUE_API_KEY_ID: 'kid',
    QUEUE_API_KEY_SECRET: 'ksecret',
    ...over,
  } as unknown as { DB_SHARD0: D1Database & { rows: Row[] }; OAUTH_KV: KVNamespace & { store: Map<string, string> } } & Record<string, unknown>;
}

function post(body: unknown, ip = '203.0.113.7'): Request {
  return new Request(`${BASE}/api/tools/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, origin: 'https://slashloop.dev' },
    body: JSON.stringify(body),
  });
}
const goodBody = (handle = 'mrbeast') => ({ kind: 'profile-lite', handle, turnstileToken: 'tok' });

function deps(published: PublishBody[], over: Partial<ToolsLookupDeps> = {}): ToolsLookupDeps {
  let n = 0;
  return {
    now: () => NOW,
    newId: () => `id${++n}`,
    publish: async (_cfg, body) => {
      published.push(body);
      return { jobId: `job${n}`, deduped: false } as never;
    },
    ...over,
  };
}

async function signedCallback(env: Record<string, unknown>, payload: unknown, opts: { secret?: string; ts?: number; nonce?: string } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const ts = String(opts.ts ?? Math.floor(NOW.getTime() / 1000));
  const nonce = opts.nonce ?? 'nonce-0001';
  const sig = await producerSignature(opts.secret ?? SECRET, 'POST', RESULT_PATH, ts, nonce, raw);
  const req = new Request(`${BASE}${RESULT_PATH}`, {
    method: 'POST',
    headers: { 'x-slq-key-id': 'tools', 'x-slq-timestamp': ts, 'x-slq-nonce': nonce, 'x-slq-signature': sig },
    body: raw,
  });
  return handleResultCallback(req, env as never, { now: () => NOW });
}

describe('normalizeHandle', () => {
  test('accepts handles, @handles and profile URLs; lowercases', () => {
    expect(normalizeHandle('MrBeast')).toBe('mrbeast');
    expect(normalizeHandle('@a.b_c')).toBe('a.b_c');
    expect(normalizeHandle('https://www.tiktok.com/@SomeOne?lang=en')).toBe('someone');
  });
  test('rejects junk', () => {
    for (const bad of ['', 'a', 'x'.repeat(25), 'bad handle', 'a/b', '../x', "x';--", 42, null, undefined]) {
      expect(normalizeHandle(bad as never)).toBeNull();
    }
  });
});

describe('POST /api/tools/lookup', () => {
  test('bogus handle -> 400 before any job', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post({ ...goodBody(), handle: 'bad handle!' }), env as never, deps(published));
    expect(res.status).toBe(400);
    expect(published).toHaveLength(0);
    expect(env.DB_SHARD0.rows).toHaveLength(0);
    expect(turnstileCalls).toBe(0);
  });

  test('wrong kind -> 400', async () => {
    for (const kind of ['video', 'constructor', '__proto__', 42]) {
      const res = await handleLookupPost(post({ ...goodBody(), kind }), makeEnv() as never, deps([]));
      expect(res.status).toBe(400);
    }
  });

  test('profile kind queues tools-profile with its own cache, row kind and daily counters', async () => {
    const env = makeEnv();
    await env.OAUTH_KV.put('tools:cache:profile-lite:mrbeast', JSON.stringify({ handle: 'mrbeast', followers: 5 }));
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post({ ...goodBody(), kind: 'profile' }), env as never, deps(published));
    expect(await res.json()).toEqual({ status: 'queued', id: 'id1' });
    expect(published[0].kind).toBe('tools-profile');
    expect(published[0].dedupeKey).toBe('tools-profile:mrbeast:20261026');
    expect(env.DB_SHARD0.rows[0]).toMatchObject({ kind: 'profile', subject: 'mrbeast' });
    const keys = [...env.OAUTH_KV.store.keys()];
    expect(keys).toContain('tools:rl:handle:profile:mrbeast:20261026');
    expect(keys.some((k) => k.startsWith('tools:rl:day:profile:'))).toBe(true);
  });

  test('a cached profile result is served for kind profile only', async () => {
    const env = makeEnv();
    await env.OAUTH_KV.put('tools:cache:profile:mrbeast', JSON.stringify({ handle: 'mrbeast', followers: 50000 }));
    const res = await handleLookupPost(post({ kind: 'profile', handle: 'mrbeast' }), env as never, deps([]));
    expect(await res.json()).toEqual({ status: 'done', result: { handle: 'mrbeast', followers: 50000 }, cached: true });
  });

  test('missing or failed Turnstile -> 400, nothing queued', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    expect((await handleLookupPost(post({ kind: 'profile-lite', handle: 'mrbeast' }), env as never, deps(published))).status).toBe(400);
    turnstileOk = false;
    expect((await handleLookupPost(post(goodBody()), env as never, deps(published))).status).toBe(400);
    expect(published).toHaveLength(0);
    expect(env.DB_SHARD0.rows).toHaveLength(0);
  });

  test('cache hit answers without Turnstile, limiter or queue', async () => {
    const env = makeEnv({ LOOKUP_RL: { limit: async () => { throw new Error('limiter must not run'); } } });
    await env.OAUTH_KV.put('tools:cache:profile-lite:mrbeast', JSON.stringify({ handle: 'mrbeast', followers: 5 }));
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post({ kind: 'profile-lite', handle: 'MrBeast' }), env as never, deps(published));
    expect(await res.json()).toEqual({ status: 'done', result: { handle: 'mrbeast', followers: 5 }, cached: true });
    expect(turnstileCalls).toBe(0);
    expect(published).toHaveLength(0);
  });

  test('refresh of a snapshot under 24h old is still served from the cache', async () => {
    const env = makeEnv();
    const fresh = { handle: 'mrbeast', followers: 5, takenAt: new Date(NOW.getTime() - 3600_000).toISOString() };
    await env.OAUTH_KV.put('tools:cache:profile-lite:mrbeast', JSON.stringify(fresh));
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post({ kind: 'profile-lite', handle: 'mrbeast', refresh: true }), env as never, deps(published));
    expect(await res.json()).toEqual({ status: 'done', result: fresh, cached: true });
    expect(published).toHaveLength(0);
  });

  test('refresh of a 24h+ snapshot needs Turnstile and queues a new job; without refresh it stays cached', async () => {
    const env = makeEnv();
    const old = { handle: 'mrbeast', followers: 5, takenAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() };
    await env.OAUTH_KV.put('tools:cache:profile-lite:mrbeast', JSON.stringify(old));
    const published: PublishBody[] = [];
    const plain = await handleLookupPost(post({ kind: 'profile-lite', handle: 'mrbeast' }), env as never, deps(published));
    expect((await plain.json() as { cached: boolean }).cached).toBe(true);
    const noToken = await handleLookupPost(post({ kind: 'profile-lite', handle: 'mrbeast', refresh: true }), env as never, deps(published));
    expect(noToken.status).toBe(400);
    const res = await handleLookupPost(post({ ...goodBody(), refresh: true }), env as never, deps(published));
    expect(await res.json()).toEqual({ status: 'queued', id: 'id1' });
    expect(published).toHaveLength(1);
  });

  test('publishes one signed-job body for the tools workspace and returns the request id', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post(goodBody()), env as never, deps(published));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'queued', id: 'id1' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://slashloop.dev');
    expect(published).toHaveLength(1);
    const job = published[0];
    expect(job.kind).toBe('tools-profile-lite');
    expect(job.workspaceId).toBe('ws-tools');
    expect(job.videoId).toBeNull();
    expect(job.sourceId).toBeNull();
    expect(job.dedupeKey).toBe('tools-profile-lite:mrbeast:20261026');
    expect(job.payload).toEqual({ handle: 'mrbeast', requestId: 'id1', callbackUrl: `${BASE}/api/tools/internal/result` });
    expect(env.DB_SHARD0.rows[0]).toMatchObject({ id: 'id1', subject: 'mrbeast', status: 'queued' });
  });

  test('PUBLIC_URL overrides the callback origin', async () => {
    const env = makeEnv({ PUBLIC_URL: 'https://api.example.test/' });
    const published: PublishBody[] = [];
    await handleLookupPost(post(goodBody()), env as never, deps(published));
    expect((published[0].payload as { callbackUrl: string }).callbackUrl).toBe('https://api.example.test/api/tools/internal/result');
  });

  test('per-IP limiter -> 429 and nothing queued', async () => {
    const env = makeEnv({ LOOKUP_RL: { limit: async () => ({ success: false }) } });
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post(goodBody()), env as never, deps(published));
    expect(res.status).toBe(429);
    expect(published).toHaveLength(0);
  });

  test('4th new lookup from one client within a minute -> 429, even when LOOKUP_RL lets it through', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const d = deps(published);
    for (const h of ['khaby.lame', 'bellapoarch', 'mrbeast']) {
      expect((await handleLookupPost(post(goodBody(h)), env as never, d)).status).toBe(200);
    }
    const res = await handleLookupPost(post(goodBody('charlidamelio')), env as never, d);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('Too many lookups. Wait a minute and try again.');
    expect(published).toHaveLength(3);
    // Another client is unaffected.
    expect((await handleLookupPost(post(goodBody('charlidamelio'), '198.51.100.9'), env as never, d)).status).toBe(200);
    // Following an in-flight lookup is not a new lookup.
    expect((await handleLookupPost(post(goodBody('mrbeast')), env as never, d)).status).toBe(200);
    // Lookups older than a minute stop counting.
    for (const r of env.DB_SHARD0.rows) r.created_at = new Date(NOW.getTime() - 61_000).toISOString();
    expect((await handleLookupPost(post(goodBody('charlidamelio')), env as never, d)).status).toBe(200);
  });

  test('daily per-handle and per-IP caps -> 429', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const day = '20261026';
    await env.OAUTH_KV.put(`tools:rl:handle:mrbeast:${day}`, String(DAILY_HANDLE_LIMIT));
    expect((await handleLookupPost(post(goodBody()), env as never, deps(published))).status).toBe(429);
    // A different handle from the same IP still works until the IP cap is hit.
    for (const k of [...env.OAUTH_KV.store.keys()]) if (k.includes(':rl:day:')) env.OAUTH_KV.store.delete(k);
    expect((await handleLookupPost(post(goodBody('other1')), env as never, deps(published))).status).toBe(200);
    const ipKey = [...env.OAUTH_KV.store.keys()].find((k) => k.startsWith('tools:rl:day:'))!;
    env.OAUTH_KV.store.set(ipKey, String(DAILY_IP_LIMIT));
    expect((await handleLookupPost(post(goodBody('other2')), env as never, deps(published))).status).toBe(429);
    expect(published).toHaveLength(1);
  });

  test('a pending lookup for the same handle is followed, not duplicated', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const d = deps(published);
    const first = (await (await handleLookupPost(post(goodBody()), env as never, d)).json()) as { id: string };
    const second = (await (await handleLookupPost(post(goodBody(), '198.51.100.9'), env as never, d)).json()) as { id: string };
    expect(second.id).toBe(first.id);
    expect(published).toHaveLength(1);
    expect(env.DB_SHARD0.rows).toHaveLength(1);
  });

  test('queue-side dedupe follows the earlier in-flight row', async () => {
    const env = makeEnv();
    env.DB_SHARD0.rows.push({
      id: 'old', kind: 'profile-lite', subject: 'mrbeast', status: 'queued', result_json: null, error_code: null,
      created_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    });
    const res = await handleLookupPost(post(goodBody()), env as never, deps([], { publish: async () => ({ jobId: 'j', deduped: true } as never) }));
    expect(await res.json()).toEqual({ status: 'queued', id: 'old' });
    expect(env.DB_SHARD0.rows.map((r) => r.id)).toEqual(['old']);
  });

  test('publish failure -> 503, row marked failed, no quota consumed', async () => {
    const env = makeEnv();
    const res = await handleLookupPost(
      post(goodBody()),
      env as never,
      deps([], { publish: async () => { throw Object.assign(new Error('down'), { code: 'network' }); } }),
    );
    expect(res.status).toBe(503);
    expect(env.DB_SHARD0.rows[0]).toMatchObject({ status: 'failed', error_code: 'queue' });
    expect([...env.OAUTH_KV.store.keys()].filter((k) => k.includes(':rl:'))).toHaveLength(0);
  });

  test('unconfigured workspace/queue -> 503 without writing a row', async () => {
    const env = makeEnv({ TOOLS_WORKSPACE_ID: undefined });
    const res = await handleLookupPost(post(goodBody()), env as never, deps([]));
    expect(res.status).toBe(503);
    expect(env.DB_SHARD0.rows).toHaveLength(0);
  });
});

describe('POST /api/tools/internal/result', () => {
  const queuedRow = (env: ReturnType<typeof makeEnv>) =>
    env.DB_SHARD0.rows.push({
      id: 'req1', kind: 'profile-lite', subject: 'mrbeast', status: 'queued', result_json: null, error_code: null,
      created_at: NOW.toISOString(),
    });

  test('401 for unsigned, wrong secret, stale timestamp and replayed nonce', async () => {
    const env = makeEnv();
    queuedRow(env);
    const unsigned = await handleResultCallback(
      new Request(`${BASE}${RESULT_PATH}`, { method: 'POST', body: '{}' }),
      env as never,
      { now: () => NOW },
    );
    expect(unsigned.status).toBe(401);
    const payload = { requestId: 'req1', status: 'done', result: { followers: 1 } };
    expect((await signedCallback(env, payload, { secret: 'wrong' })).status).toBe(401);
    expect((await signedCallback(env, payload, { ts: Math.floor(NOW.getTime() / 1000) - 3600 })).status).toBe(401);
    expect((await signedCallback(env, payload, { nonce: 'nonce-ok-1' })).status).toBe(204);
    expect((await signedCallback(env, payload, { nonce: 'nonce-ok-1' })).status).toBe(401);
  });

  test('done stores the result on the row and in the 7d cache with the forced handle', async () => {
    const env = makeEnv();
    queuedRow(env);
    const res = await signedCallback(env, { requestId: 'req1', status: 'done', result: { handle: 'someoneelse', followers: 9 } });
    expect(res.status).toBe(204);
    expect(JSON.parse(env.DB_SHARD0.rows[0].result_json!)).toEqual({ handle: 'mrbeast', followers: 9 });
    expect(JSON.parse(env.OAUTH_KV.store.get('tools:cache:profile-lite:mrbeast')!)).toEqual({ handle: 'mrbeast', followers: 9 });
    const poll = await handleLookupGet(new Request(`${BASE}/api/tools/lookup/req1`), 'req1', env as never);
    expect(await poll.json()).toEqual({ status: 'done', result: { handle: 'mrbeast', followers: 9 } });
  });

  describe('profile kind', () => {
    const profileRow = (env: ReturnType<typeof makeEnv>) =>
      env.DB_SHARD0.rows.push({
        id: 'req1', kind: 'profile', subject: 'mrbeast', status: 'queued', result_json: null, error_code: null,
        created_at: NOW.toISOString(),
      });
    const pushes: Array<{ url: string; headers: Headers; body: string }> = [];
    const pushFetch = (status: number) =>
      (async (url: string, init: RequestInit) => {
        pushes.push({ url, headers: new Headers(init.headers), body: new TextDecoder().decode(init.body as Uint8Array) });
        return new Response(null, { status });
      }) as unknown as typeof fetch;

    test('done pushes the signed result to the site first, then caches under the profile key', async () => {
      pushes.length = 0;
      const env = makeEnv();
      profileRow(env);
      const raw = new TextEncoder().encode(JSON.stringify({ requestId: 'req1', status: 'done', result: { handle: 'x', followers: 20000 } }));
      const sig = await producerSignature(SECRET, 'POST', RESULT_PATH, String(Math.floor(NOW.getTime() / 1000)), 'nonce-0001', raw);
      const res = await handleResultCallback(
        new Request(`${BASE}${RESULT_PATH}`, {
          method: 'POST',
          headers: { 'x-slq-timestamp': String(Math.floor(NOW.getTime() / 1000)), 'x-slq-nonce': 'nonce-0001', 'x-slq-signature': sig },
          body: raw,
        }),
        env as never,
        { now: () => NOW, fetchImpl: pushFetch(204) },
      );
      expect(res.status).toBe(204);
      expect(pushes).toHaveLength(1);
      expect(pushes[0].url).toBe('https://slashloop.dev/tools/api/internal/creator');
      expect(JSON.parse(pushes[0].body)).toEqual({ handle: 'mrbeast', result: { handle: 'mrbeast', followers: 20000 } });
      const expected = await producerSignature(
        SECRET, 'POST', '/tools/api/internal/creator', pushes[0].headers.get('x-slq-timestamp')!, pushes[0].headers.get('x-slq-nonce')!,
        new TextEncoder().encode(pushes[0].body),
      );
      expect(pushes[0].headers.get('x-slq-signature')).toBe(expected);
      expect(env.DB_SHARD0.rows[0].status).toBe('done');
      expect(env.OAUTH_KV.store.has('tools:cache:profile:mrbeast')).toBe(true);
      expect(env.OAUTH_KV.store.has('tools:cache:profile-lite:mrbeast')).toBe(false);
    });

    test('a failed site push answers 502 and leaves the row queued so the VPS retries', async () => {
      pushes.length = 0;
      const env = makeEnv();
      profileRow(env);
      globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
      const res = await signedCallback(env, { requestId: 'req1', status: 'done', result: { followers: 20000 } }, { nonce: 'nonce-push-1' });
      expect(res.status).toBe(502);
      expect(env.DB_SHARD0.rows[0].status).toBe('queued');
      expect(env.OAUTH_KV.store.has('tools:cache:profile:mrbeast')).toBe(false);
    });

    test('profile-lite results are never pushed to the site', async () => {
      pushes.length = 0;
      const env = makeEnv();
      queuedRow(env);
      expect((await signedCallback(env, { requestId: 'req1', status: 'done', result: { followers: 1 } })).status).toBe(204);
      expect(pushes).toHaveLength(0);
    });
  });

  test('a redelivery after the row settled is acknowledged without changing it', async () => {
    const env = makeEnv();
    queuedRow(env);
    await signedCallback(env, { requestId: 'req1', status: 'done', result: { followers: 1 } }, { nonce: 'nonce-aaaa' });
    const again = await signedCallback(env, { requestId: 'req1', status: 'failed', code: 'blocked' }, { nonce: 'nonce-bbbb' });
    expect(again.status).toBe(204);
    expect(env.DB_SHARD0.rows[0].status).toBe('done');
  });

  test('failure codes map to visitor messages via GET; unknown codes become generic', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['budget', 'budget', /budget/i],
      ['not_found', 'not_found', /does not exist or is private/],
      ['blocked', 'blocked', /rate limiting/],
      ['weird', 'error', /failed/],
    ];
    for (const [sent, stored, message] of cases) {
      const env = makeEnv();
      queuedRow(env);
      expect((await signedCallback(env, { requestId: 'req1', status: 'failed', code: sent })).status).toBe(204);
      const body = (await (await handleLookupGet(new Request(`${BASE}/api/tools/lookup/req1`), 'req1', env as never)).json()) as {
        status: string; code: string; message: string;
      };
      expect(body.status).toBe('failed');
      expect(body.code).toBe(stored);
      expect(body.message).toMatch(message);
    }
  });

  test('unknown request id -> 404', async () => {
    const res = await signedCallback(makeEnv(), { requestId: 'nope', status: 'done', result: {} });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tools/lookup/<id>', () => {
  test('queued then 404 for unknown / malformed ids', async () => {
    const env = makeEnv();
    env.DB_SHARD0.rows.push({
      id: 'req1', kind: 'profile-lite', subject: 'mrbeast', status: 'queued', result_json: null, error_code: null,
      created_at: NOW.toISOString(),
    });
    const ok = await handleLookupGet(new Request(`${BASE}/api/tools/lookup/req1`), 'req1', env as never);
    expect(await ok.json()).toEqual({ status: 'queued', id: 'req1' });
    expect((await handleLookupGet(new Request(`${BASE}/api/tools/lookup/zzz`), 'zzz', env as never)).status).toBe(404);
    expect((await handleLookupGet(new Request(`${BASE}/api/tools/lookup/a%20b`), 'a b', env as never)).status).toBe(404);
  });
});

describe('transcript kind (SLA-1057)', () => {
  const VID = '7234567890123456789';
  const CANON = `https://www.tiktok.com/@some.user/video/${VID}`;
  const OEMBED = { title: 'hook line #fyp', author_name: 'Some User', thumbnail_url: 'https://p16.tiktokcdn.com/t.jpg' };

  interface Net { calls: string[]; oembedStatus: number; headLocation: string | null; headStatus: number }
  function net(over: Partial<Net> = {}): { n: Net; fetchImpl: typeof fetch } {
    const n: Net = { calls: [], oembedStatus: 200, headLocation: `${CANON}?_r=1`, headStatus: 301, ...over };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      n.calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('turnstile')) return new Response(JSON.stringify({ success: turnstileOk }), { status: 200 });
      if (url.includes('/oembed')) return new Response(JSON.stringify(OEMBED), { status: n.oembedStatus });
      if (init?.method === 'HEAD') {
        return new Response(null, { status: n.headStatus, headers: n.headLocation ? { location: n.headLocation } : {} });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    return { n, fetchImpl };
  }
  const vbody = (url: string) => ({ kind: 'transcript', url, turnstileToken: 'tok' });

  test('canonical video URL queues tools-video with the dedupe key, payload and preview', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    const { fetchImpl } = net();
    const res = await handleLookupPost(post(vbody(`https://www.tiktok.com/@Some.User/video/${VID}?lang=en`)), env as never, deps(published, { fetchImpl }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.json()).toEqual({
      status: 'queued', id: 'id1',
      preview: { title: 'hook line #fyp', author: 'Some User', thumbnailUrl: 'https://p16.tiktokcdn.com/t.jpg' },
    });
    expect(published[0].kind).toBe('tools-video');
    expect(published[0].dedupeKey).toBe(`tools-video:${VID}`);
    expect(published[0].payload).toEqual({
      videoUrl: `https://www.tiktok.com/@Some.User/video/${VID}`, videoId: VID, caption: 'hook line #fyp',
      requestId: 'id1', callbackUrl: `${BASE}/api/tools/internal/result`,
    });
    expect(env.DB_SHARD0.rows[0]).toMatchObject({ kind: 'transcript', subject: VID });
  });

  test('vm.tiktok.com and tiktok.com/t/ links resolve via HEAD with manual redirects', async () => {
    for (const link of ['https://vm.tiktok.com/ZMabc123/', 'vm.tiktok.com/ZMabc123', 'https://www.tiktok.com/t/ZTabc123/']) {
      const env = makeEnv();
      const published: PublishBody[] = [];
      const { n, fetchImpl } = net({ headLocation: `${CANON}?_r=1&u_code=x` });
      const res = await handleLookupPost(post(vbody(link)), env as never, deps(published, { fetchImpl }));
      expect(res.status).toBe(200);
      expect(n.calls.some((c) => c.startsWith('HEAD '))).toBe(true);
      expect((published[0].payload as { videoId: string }).videoId).toBe(VID);
    }
  });

  test('a short link that does not land on a video, or leaves tiktok.com, -> 400', async () => {
    for (const headLocation of ['https://evil.example/x', 'https://www.tiktok.com/@some.user', null]) {
      const published: PublishBody[] = [];
      const { fetchImpl } = net({ headLocation });
      const res = await handleLookupPost(post(vbody('https://vm.tiktok.com/ZMabc123/')), makeEnv() as never, deps(published, { fetchImpl }));
      expect(res.status).toBe(400);
      expect(published).toHaveLength(0);
    }
  });

  test('non-TikTok and malformed URLs -> 400 before any fetch or job', async () => {
    for (const bad of ['https://example.com/@a/video/7234567890123456789', 'https://tiktok.com.evil.test/@a/video/7234567890123456789', 'javascript:alert(1)', 'https://www.tiktok.com/@some.user', 'https://user:pw@www.tiktok.com/@a/video/7234567890123456789', '', 42]) {
      const env = makeEnv();
      const published: PublishBody[] = [];
      const { n, fetchImpl } = net();
      const res = await handleLookupPost(post(vbody(bad as never)), env as never, deps(published, { fetchImpl }));
      expect(res.status).toBe(400);
      expect(n.calls).toHaveLength(0);
      expect(published).toHaveLength(0);
      expect(env.DB_SHARD0.rows).toHaveLength(0);
    }
  });

  test('photo links answer with the slideshow message without queueing', async () => {
    const published: PublishBody[] = [];
    const { fetchImpl } = net();
    const res = await handleLookupPost(post(vbody(`https://www.tiktok.com/@a.b/photo/${VID}`)), makeEnv() as never, deps(published, { fetchImpl }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'slideshow', error: expect.stringMatching(/photo slideshow/) });
    expect(published).toHaveLength(0);
  });

  test('oEmbed 404 -> video not found or private, no job; oEmbed outage still queues without a preview', async () => {
    const published: PublishBody[] = [];
    const gone = net({ oembedStatus: 404 });
    const res = await handleLookupPost(post(vbody(CANON)), makeEnv() as never, deps(published, { fetchImpl: gone.fetchImpl }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/not found or private/i);
    expect(published).toHaveLength(0);

    const down = net({ oembedStatus: 503 });
    const ok = await handleLookupPost(post(vbody(CANON)), makeEnv() as never, deps(published, { fetchImpl: down.fetchImpl }));
    expect(await ok.json()).toEqual({ status: 'queued', id: 'id1' });
    expect((published[0].payload as { caption: string }).caption).toBe('');
  });

  test('cache hit on transcript:<videoId> skips Turnstile, limits and queue, and still returns a fresh preview', async () => {
    const env = makeEnv({ LOOKUP_RL: { limit: async () => { throw new Error('limiter must not run'); } } });
    await env.OAUTH_KV.put(`tools:cache:transcript:${VID}`, JSON.stringify({ videoId: VID, text: 'hi' }));
    const published: PublishBody[] = [];
    const { n, fetchImpl } = net();
    const res = await handleLookupPost(post({ kind: 'transcript', url: CANON }), env as never, deps(published, { fetchImpl }));
    expect(await res.json()).toMatchObject({ status: 'done', cached: true, result: { videoId: VID, text: 'hi' }, preview: { title: 'hook line #fyp' } });
    expect(n.calls.some((c) => c.includes('turnstile'))).toBe(false);
    expect(published).toHaveLength(0);
  });

  test('refresh never bypasses the transcript cache', async () => {
    const env = makeEnv();
    const old = { videoId: VID, text: 'hi', takenAt: new Date(NOW.getTime() - 40 * 24 * 3600_000).toISOString() };
    await env.OAUTH_KV.put(`tools:cache:transcript:${VID}`, JSON.stringify(old));
    const published: PublishBody[] = [];
    const res = await handleLookupPost(post({ ...vbody(CANON), refresh: true }), env as never, deps(published, { fetchImpl: net().fetchImpl }));
    expect(((await res.json()) as { cached: boolean }).cached).toBe(true);
    expect(published).toHaveLength(0);
  });

  test('3 per video per day and 10 per IP per day for this kind -> 429', async () => {
    const day = '20261026';
    const env = makeEnv();
    const published: PublishBody[] = [];
    await env.OAUTH_KV.put(`tools:rl:video:${VID}:${day}`, String(DAILY_VIDEO_LIMIT));
    const perVideo = await handleLookupPost(post(vbody(CANON)), env as never, deps(published, { fetchImpl: net().fetchImpl }));
    expect(perVideo.status).toBe(429);
    expect(DAILY_VIDEO_LIMIT).toBe(3);

    const env2 = makeEnv();
    const d = deps(published, { fetchImpl: net().fetchImpl });
    expect((await handleLookupPost(post(vbody(CANON)), env2 as never, d)).status).toBe(200);
    const ipKey = [...env2.OAUTH_KV.store.keys()].find((k) => k.startsWith('tools:rl:day:video:'))!;
    expect(DAILY_VIDEO_IP_LIMIT).toBe(10);
    env2.OAUTH_KV.store.set(ipKey, String(DAILY_VIDEO_IP_LIMIT));
    const other = `https://www.tiktok.com/@some.user/video/7234567890123456790`;
    expect((await handleLookupPost(post(vbody(other)), env2 as never, d)).status).toBe(429);
    // Profile lookups keep their own IP counter.
    expect((await handleLookupPost(post(goodBody('other1')), env2 as never, d)).status).toBe(200);
  });

  test('callback: done sets videoId, caches 30 days under transcript:<id>; slideshow/too_long/not_found map to messages', async () => {
    const env = makeEnv();
    env.DB_SHARD0.rows.push({ id: 'req1', kind: 'transcript', subject: VID, status: 'queued', result_json: null, error_code: null, created_at: NOW.toISOString() });
    const res = await signedCallback(env, { requestId: 'req1', status: 'done', result: { videoId: 'other', text: 'hello', segments: [] } });
    expect(res.status).toBe(204);
    expect(JSON.parse(env.OAUTH_KV.store.get(`tools:cache:transcript:${VID}`)!)).toEqual({ videoId: VID, text: 'hello', segments: [] });
    expect(env.OAUTH_KV.store.has('tools:cache:profile-lite:' + VID)).toBe(false);

    const cases: Array<[string, RegExp]> = [['slideshow', /photo slideshow/], ['too_long', /too long/], ['not_found', /^Video not found or private/]];
    for (const [code, message] of cases) {
      const e = makeEnv();
      e.DB_SHARD0.rows.push({ id: 'req1', kind: 'transcript', subject: VID, status: 'queued', result_json: null, error_code: null, created_at: NOW.toISOString() });
      await signedCallback(e, { requestId: 'req1', status: 'failed', code });
      const poll = await handleLookupGet(new Request(`${BASE}/api/tools/lookup/req1`), 'req1', e as never);
      expect(poll.headers.get('x-robots-tag')).toBe('noindex');
      expect(await poll.json()).toMatchObject({ status: 'failed', code, message: expect.stringMatching(message) });
    }
  });
});
