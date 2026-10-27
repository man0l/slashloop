import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { producerSignature, type PublishBody } from '../queue/producer.js';
import { DAILY_REMOVAL_LIMIT, MAX_REFRESH_HANDLES, REFRESH_PATH, REMOVAL_PATH, handleRefresh, handleRemoval } from './tools-creators.js';

const NOW = new Date('2026-10-27T05:00:00Z');
const SECRET = 'cb-secret';
const BASE = 'https://mcp.slashloop.dev';

interface Row { id: string; kind: string; subject: string; status: string; error_code: string | null; client_hash: string }

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function fakeDb() {
  const rows: Row[] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    async run() {
      if (sql.startsWith('INSERT INTO tools_lookups')) {
        const [id, kind, subject] = args as string[];
        rows.push({ id, kind, subject, status: 'queued', error_code: null, client_hash: sql.includes("'refresh'") ? 'refresh' : '' });
      } else if (sql.startsWith('DELETE FROM tools_lookups')) {
        rows.splice(rows.findIndex((r) => r.id === args[0]), 1);
      } else if (sql.includes("SET status = 'failed'")) {
        const row = rows.find((r) => r.id === args[1])!;
        row.status = 'failed';
        row.error_code = 'queue';
      } else throw new Error(`unexpected run(): ${sql}`);
      return { success: true };
    },
  });
  return {
    rows,
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
  } as unknown as D1Database & { rows: Row[] };
}

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    DB_SHARD0: fakeDb(),
    OAUTH_KV: fakeKv(),
    TURNSTILE_SECRET: 'ts',
    TOOLS_CALLBACK_SECRET: SECRET,
    TOOLS_WORKSPACE_ID: 'ws-tools',
    ALERT_EMAIL: 'board@example.test',
    QUEUE_API_URL: 'https://queue.example.test',
    QUEUE_API_KEY_ID: 'kid',
    QUEUE_API_KEY_SECRET: 'ksecret',
    ...over,
  } as unknown as { DB_SHARD0: D1Database & { rows: Row[] }; OAUTH_KV: KVNamespace & { store: Map<string, string> } } & Record<string, unknown>;
}

async function signedRefresh(env: Record<string, unknown>, payload: unknown, deps: Parameters<typeof handleRefresh>[2], opts: { secret?: string; nonce?: string } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const nonce = opts.nonce ?? 'nonce-refresh-1';
  const sig = await producerSignature(opts.secret ?? SECRET, 'POST', REFRESH_PATH, ts, nonce, raw);
  return handleRefresh(
    new Request(`${BASE}${REFRESH_PATH}`, { method: 'POST', headers: { 'x-slq-timestamp': ts, 'x-slq-nonce': nonce, 'x-slq-signature': sig }, body: raw }),
    env as never,
    { now: () => NOW, ...deps },
  );
}

describe('POST /api/tools/internal/refresh', () => {
  test('publishes one tools-profile refresh job per handle with the weekly dedupe key', async () => {
    const env = makeEnv();
    const published: PublishBody[] = [];
    let n = 0;
    const res = await signedRefresh(env, { week: '2026-W44', handles: ['MrBeast', 'khaby.lame', 'mrbeast', 'bad handle'] }, {
      newId: () => `id${++n}`,
      publish: async (_c, b) => { published.push(b); return { jobId: 'j', deduped: false } as never; },
    });
    expect(await res.json()).toEqual({ week: '2026-W44', requested: 2, published: 2, deduped: 0, failed: 0 });
    expect(published.map((p) => p.dedupeKey).sort()).toEqual(['tools-profile:khaby.lame:refresh:2026-W44', 'tools-profile:mrbeast:refresh:2026-W44']);
    for (const job of published) {
      expect(job.kind).toBe('tools-profile');
      expect(job.workspaceId).toBe('ws-tools');
      expect((job.payload as { reason: string }).reason).toBe('refresh');
      expect((job.payload as { callbackUrl: string }).callbackUrl).toBe(`${BASE}/api/tools/internal/result`);
    }
    expect(env.DB_SHARD0.rows.map((r) => r.kind)).toEqual(['profile', 'profile']);
  });

  test('a deduped job drops its row; a failed publish marks it failed and is counted', async () => {
    const env = makeEnv();
    const res = await signedRefresh(env, { week: '2026-W44', handles: ['aaaa', 'bbbb', 'cccc'] }, {
      newId: (() => { let n = 0; return () => `id${++n}`; })(),
      publish: async (_c, b) => {
        const h = (b.payload as { handle: string }).handle;
        if (h === 'aaaa') return { jobId: 'j', deduped: true } as never;
        if (h === 'bbbb') throw Object.assign(new Error('down'), { code: 'network' });
        return { jobId: 'j', deduped: false } as never;
      },
    });
    expect(await res.json()).toEqual({ week: '2026-W44', requested: 3, published: 1, deduped: 1, failed: 1 });
    expect(env.DB_SHARD0.rows.map((r) => [r.subject, r.status])).toEqual([['bbbb', 'failed'], ['cccc', 'queued']]);
  });

  test('401 without a valid signature; 400 for a bad week or too many handles; nothing is published', async () => {
    const published: PublishBody[] = [];
    const deps = { publish: async (_c: unknown, b: PublishBody) => { published.push(b); return { jobId: 'j', deduped: false } as never; } };
    const env = makeEnv();
    expect((await signedRefresh(env, { week: '2026-W44', handles: ['aaaa'] }, deps, { secret: 'wrong' })).status).toBe(401);
    expect((await signedRefresh(env, { week: 'next-week', handles: ['aaaa'] }, deps, { nonce: 'nonce-bad-week' })).status).toBe(400);
    const many = Array.from({ length: MAX_REFRESH_HANDLES + 1 }, (_, i) => `user${i}`);
    expect((await signedRefresh(env, { week: '2026-W44', handles: many }, deps, { nonce: 'nonce-too-many' })).status).toBe(400);
    expect(published).toHaveLength(0);
    expect(env.DB_SHARD0.rows).toHaveLength(0);
  });

  test('reason seed publishes with the seed dedupe key and payload reason', async () => {
    const published: PublishBody[] = [];
    await signedRefresh(makeEnv(), { week: '2026-W44', reason: 'seed', handles: ['aaaa'] }, {
      publish: async (_c, b) => { published.push(b); return { jobId: 'j', deduped: false } as never; },
    });
    expect(published[0].dedupeKey).toBe('tools-profile:aaaa:seed:2026-W44');
    expect((published[0].payload as { reason: string }).reason).toBe('seed');
  });

  test('an empty handle list is a successful no-op', async () => {
    const res = await signedRefresh(makeEnv(), { week: '2026-W44', handles: [] }, {});
    expect(await res.json()).toEqual({ week: '2026-W44', requested: 0, published: 0, deduped: 0, failed: 0 });
  });
});

describe('POST /api/tools/removal', () => {
  let realFetch: typeof fetch;
  let turnstileOk: boolean;
  let sitePushStatus: number;
  let sitePushes: Array<{ url: string; body: string }>;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    turnstileOk = true;
    sitePushStatus = 204;
    sitePushes = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('turnstile')) return new Response(JSON.stringify({ success: turnstileOk }), { status: 200 });
      sitePushes.push({ url: String(url), body: new TextDecoder().decode(init?.body as Uint8Array) });
      return new Response(null, { status: sitePushStatus });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const req = (body: unknown, ip = '203.0.113.7') =>
    new Request(`${BASE}${REMOVAL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, origin: 'https://slashloop.dev' },
      body: JSON.stringify(body),
    });
  const good = { handle: 'MrBeast', email: 'me@example.test', reason: 'It is my account <b>please</b>', turnstileToken: 'tok' };

  test('hides the page on the site, then emails the board with escaped HTML', async () => {
    const env = makeEnv();
    const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
    const res = await handleRemoval(req(good), env as never, { now: () => NOW, send: async (i) => { sent.push(i); return { sent: true }; } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'removed', handle: 'mrbeast' });
    expect(sitePushes).toHaveLength(1);
    expect(sitePushes[0].url).toBe('https://slashloop.dev/tools/api/internal/removal');
    expect(JSON.parse(sitePushes[0].body)).toMatchObject({ handle: 'mrbeast', email: 'me@example.test', reason: 'It is my account <b>please</b>' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('board@example.test');
    expect(sent[0].subject).toContain('@mrbeast');
    expect(sent[0].html).toContain('&lt;b&gt;please&lt;/b&gt;');
    expect(sent[0].html).not.toContain('<b>');
  });

  test('a mail outage does not undo the removal', async () => {
    const res = await handleRemoval(req(good), makeEnv() as never, { now: () => NOW, send: async () => ({ sent: false, reason: 'down' }) });
    expect(res.status).toBe(200);
    expect(sitePushes).toHaveLength(1);
  });

  test('site push failure -> 502 and no email', async () => {
    sitePushStatus = 500;
    let mails = 0;
    const res = await handleRemoval(req(good), makeEnv() as never, { now: () => NOW, send: async () => { mails++; return { sent: true }; } });
    expect(res.status).toBe(502);
    expect(mails).toBe(0);
  });

  test('bad handle, bad email, missing or failed Turnstile -> 400 with nothing pushed', async () => {
    const env = makeEnv();
    const d = { now: () => NOW, send: async () => ({ sent: true }) };
    expect((await handleRemoval(req({ ...good, handle: 'bad handle!' }), env as never, d)).status).toBe(400);
    expect((await handleRemoval(req({ ...good, email: 'not-an-email' }), env as never, d)).status).toBe(400);
    expect((await handleRemoval(req({ ...good, turnstileToken: '' }), env as never, d)).status).toBe(400);
    turnstileOk = false;
    expect((await handleRemoval(req(good), env as never, d)).status).toBe(400);
    expect(sitePushes).toHaveLength(0);
  });

  test('email and reason are optional', async () => {
    const res = await handleRemoval(req({ handle: 'mrbeast', turnstileToken: 'tok' }), makeEnv() as never, { now: () => NOW, send: async () => ({ sent: true }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(sitePushes[0].body)).toMatchObject({ email: null, reason: null });
  });

  test('daily per-client cap -> 429', async () => {
    const env = makeEnv();
    const d = { now: () => NOW, send: async () => ({ sent: true }) };
    for (let i = 0; i < DAILY_REMOVAL_LIMIT; i++) expect((await handleRemoval(req(good), env as never, d)).status).toBe(200);
    expect((await handleRemoval(req(good), env as never, d)).status).toBe(429);
    expect((await handleRemoval(req(good, '198.51.100.9'), env as never, d)).status).toBe(200);
  });
});
