import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { canonicalString, hmacSign, SLQ_HEADERS, verifyAuth, mapKeyStore } from '../queue/auth.js';
import {
  callbackHostAllowed,
  classifyProfileMiss,
  classifyToolsError,
  postToolsCallback,
  PROFILE_LITE_ESTIMATE_BYTES,
  processToolsJob,
  runProfileLite,
  shapeProfileLite,
  type CallbackDeps,
  type ProfileLiteDeps,
  type ToolsJobDeps,
} from './tools-jobs.js';

const NOW = new Date('2026-10-25T12:00:00Z');

function item(i: number, o: Partial<{ likes: number; comments: number; shares: number; views: number }> = {}) {
  return {
    id: `70000000000000000${String(i).padStart(2, '0')}`,
    createTime: 1_760_000_000 + i * 3600,
    stats: {
      diggCount: o.likes ?? 100 + i,
      commentCount: o.comments ?? 10,
      shareCount: o.shares ?? 5,
      playCount: o.views ?? 2000,
    },
  };
}

describe('shapeProfileLite', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(i));

  test('averages and both engagement rates over a 12-post fixture', () => {
    const r = shapeProfileLite('creator', 10_000, items, NOW);
    expect(r.sampled).toBe(12);
    expect(r.avgLikes).toBe(105.5);
    expect(r.avgComments).toBe(10);
    expect(r.avgShares).toBe(5);
    expect(r.avgViews).toBe(2000);
    // (105.5 + 10 + 5) = 120.5 per post
    expect(r.avgEngagement).toBe(120.5);
    expect(r.erByFollowers).toBe(1.21);
    expect(r.erByViews).toBe(6.03);
    expect(r.takenAt).toBe(NOW.toISOString());
  });

  test('posts are newest first and recent is the top three', () => {
    const r = shapeProfileLite('creator', 10_000, [...items].reverse(), NOW);
    expect(r.posts[0]!.id).toBe(items[11]!.id);
    expect(r.recent.map((p) => p.id)).toEqual([items[11]!.id, items[10]!.id, items[9]!.id]);
    expect(r.recent[0]).toEqual({
      id: items[11]!.id,
      createdAt: new Date((1_760_000_000 + 11 * 3600) * 1000).toISOString(),
      likes: 111,
      comments: 10,
      shares: 5,
      views: 2000,
    });
  });

  test('caps the sample at 12 and tolerates missing followers / zero views', () => {
    const many = Array.from({ length: 20 }, (_, i) => item(i, { views: 0 }));
    const r = shapeProfileLite('creator', null, many, NOW);
    expect(r.sampled).toBe(12);
    expect(r.erByFollowers).toBeNull();
    expect(r.erByViews).toBeNull();
  });

  test('string counters and items without stats do not produce NaN', () => {
    const r = shapeProfileLite('c', 500, [{ id: '1', stats: { diggCount: '40', playCount: '400' } }, { id: '2' }], NOW);
    expect(r.avgLikes).toBe(20);
    expect(r.erByViews).toBe(10);
    expect(Number.isNaN(r.avgEngagement)).toBe(false);
  });
});

describe('error mapping', () => {
  test('budget error', () => {
    const e = new Error('Proxy traffic cap exceeded');
    e.name = 'TrafficCapExceededError';
    expect(classifyToolsError(e)).toBe('budget');
  });
  test('429 / waf are blocked, anything else is error', () => {
    expect(classifyToolsError(new Error('request failed with status 429'))).toBe('blocked');
    expect(classifyToolsError(new Error('WAF challenge unsolved'))).toBe('blocked');
    expect(classifyToolsError(new Error('boom'))).toBe('error');
  });
  test('profile misses', () => {
    expect(classifyProfileMiss({ status: 404, text: '' })).toBe('not_found');
    expect(classifyProfileMiss({ status: 429, text: 'x' })).toBe('blocked');
    expect(classifyProfileMiss({ status: 200, text: '' })).toBe('blocked');
    expect(classifyProfileMiss({ status: 200, text: '<html>Please wait...</html>' })).toBe('blocked');
    expect(classifyProfileMiss({ status: 200, text: '<html>nothing useful</html>' })).toBe('blocked');
    const state = JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { statusCode: 10221 } } });
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${state}</script>`;
    expect(classifyProfileMiss({ status: 200, text: html })).toBe('not_found');
    expect(classifyProfileMiss(null)).toBe('error');
  });
});

function lookupDeps(over: Partial<ProfileLiteDeps> = {}): ProfileLiteDeps {
  return {
    assertBudget: async () => {},
    resolveCreator: async () => ({ secUid: 'sec', handle: 'creator', followers: 10_000 }),
    fetchPosts: async () => Array.from({ length: 12 }, (_, i) => item(i)),
    probe: () => null,
    now: () => NOW,
    ...over,
  };
}

describe('runProfileLite', () => {
  test('checks the budget before any scrape and maps a budget refusal', async () => {
    let scraped = false;
    const err = new Error('cap');
    err.name = 'TrafficCapExceededError';
    const seen: number[] = [];
    const out = await runProfileLite('creator', lookupDeps({
      assertBudget: async (b) => { seen.push(b); throw err; },
      resolveCreator: async () => { scraped = true; return null; },
    }));
    expect(out).toEqual({ status: 'failed', code: 'budget' });
    expect(seen).toEqual([PROFILE_LITE_ESTIMATE_BYTES]);
    expect(scraped).toBe(false);
  });

  test('done outcome carries the shaped result', async () => {
    const out = await runProfileLite('creator', lookupDeps());
    expect(out.status).toBe('done');
    if (out.status === 'done') expect(out.result.erByFollowers).toBe(1.21);
  });

  test('missing account -> not_found, blocked profile page -> blocked', async () => {
    expect(await runProfileLite('x1', lookupDeps({
      resolveCreator: async () => null,
      probe: () => ({ status: 404, text: '' }),
    }))).toEqual({ status: 'failed', code: 'not_found' });
    expect(await runProfileLite('x1', lookupDeps({
      resolveCreator: async () => null,
      probe: () => ({ status: 200, text: '' }),
    }))).toEqual({ status: 'failed', code: 'blocked' });
  });

  test('no readable posts -> not_found; scrape throw -> error', async () => {
    expect(await runProfileLite('x1', lookupDeps({ fetchPosts: async () => [] })))
      .toEqual({ status: 'failed', code: 'not_found' });
    expect(await runProfileLite('x1', lookupDeps({ fetchPosts: async () => { throw new Error('boom'); } })))
      .toEqual({ status: 'failed', code: 'error' });
  });
});

describe('callback', () => {
  const URL_OK = 'https://mcp.slashloop.dev/api/tools/internal/result';

  test('host allowlist: https + mcp.slashloop.dev only', () => {
    expect(callbackHostAllowed(URL_OK, {})).toBe(true);
    expect(callbackHostAllowed('http://mcp.slashloop.dev/x', {})).toBe(false);
    expect(callbackHostAllowed('https://evil.example/x', {})).toBe(false);
    expect(callbackHostAllowed('https://mcp.slashloop.dev@evil.example/x', {})).toBe(false);
    expect(callbackHostAllowed('nope', {})).toBe(false);
    expect(callbackHostAllowed('https://staging.example/x', { TOOLS_CALLBACK_ALLOWED_HOSTS: 'staging.example' })).toBe(true);
  });

  test('signature verifies with the queue auth envelope (method, path, ts, nonce, raw body)', async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const deps: CallbackDeps = {
      fetch: async (_u, init) => { captured = { headers: init.headers, body: init.body }; return { status: 204 }; },
      nowSeconds: () => 1_760_000_000,
      nonce: () => 'abc123',
      sleep: async () => {},
    };
    await postToolsCallback(URL_OK, 'shh', { requestId: 'r1', status: 'failed', code: 'budget' }, deps);
    const c = captured!;
    expect(c.headers[SLQ_HEADERS.timestamp]).toBe('1760000000');
    expect(c.headers[SLQ_HEADERS.nonce]).toBe('abc123');
    expect(c.headers[SLQ_HEADERS.signature]).toBe(
      hmacSign('shh', canonicalString('POST', '/api/tools/internal/result', '1760000000', 'abc123', c.body)),
    );
    const ok = verifyAuth(
      { ...c.headers, [SLQ_HEADERS.keyId]: 'k' },
      'POST',
      '/api/tools/internal/result',
      c.body,
      mapKeyStore([{ keyId: 'k', secret: 'shh', state: 'active' }]),
      1_760_000_000,
    );
    expect(ok.ok).toBe(true);
  });

  test('retries 5xx with a fresh nonce, stops on a 4xx', async () => {
    const nonces: string[] = [];
    let n = 0;
    const deps: CallbackDeps = {
      fetch: async (_u, init) => { nonces.push(init.headers[SLQ_HEADERS.nonce]!); return { status: ++n < 3 ? 503 : 204 }; },
      nowSeconds: () => 1,
      nonce: () => `n${n}`,
      sleep: async () => {},
    };
    await postToolsCallback(URL_OK, 's', {}, deps);
    expect(nonces).toEqual(['n0', 'n1', 'n2']);

    let calls = 0;
    const bad: CallbackDeps = { ...deps, fetch: async () => { calls++; return { status: 401 }; } };
    await expect(postToolsCallback(URL_OK, 's', {}, bad)).rejects.toThrow('401');
    expect(calls).toBe(1);
  });
});

describe('processToolsJob', () => {
  const WS = 'ws-tools';
  const env = { TOOLS_WORKSPACE_ID: WS, TOOLS_CALLBACK_SECRET: 'shh' };
  const job = (over: Record<string, unknown> = {}, kind = 'tools-profile-lite', workspaceId = WS) => ({
    id: 'job-12345678',
    kind,
    workspaceId,
    payloadJson: JSON.stringify({
      handle: 'Creator',
      requestId: 'req-1',
      callbackUrl: 'https://mcp.slashloop.dev/api/tools/internal/result',
      ...over,
    }),
  });

  function harness(
    lookup: Partial<ProfileLiteDeps> = {},
    envOver: Record<string, string> = {},
    seen?: { status: number; text: string },
  ) {
    const posted: unknown[] = [];
    const recorded: Array<[string, number, string]> = [];
    const completed: string[] = [];
    const failed: Array<[string, boolean]> = [];
    const deps: ToolsJobDeps = {
      env: { ...env, ...envOver } as NodeJS.ProcessEnv,
      now: () => NOW,
      measure: async (fn) => ({ value: await fn(), bytes: 1_300_000 }),
      buildLookup: (_w, onProfile) => {
        const { probe: _p, ...rest } = lookupDeps(lookup);
        return {
          ...rest,
          resolveCreator: async (h) => {
            if (seen) onProfile(seen);
            return lookup.resolveCreator ? lookup.resolveCreator(h) : rest.resolveCreator(h);
          },
        };
      },
      buildVideo: () => { throw new Error('profile tests never build video deps'); },
      recordBytes: async (w, b, r) => { recorded.push([w, b, r]); },
      callback: {
        fetch: async (_u, init) => { posted.push(JSON.parse(init.body)); return { status: 204 }; },
        nowSeconds: () => 1,
        nonce: () => 'n',
        sleep: async () => {},
      },
      completeJob: async (id) => { completed.push(id); },
      failJob: async (id, _m, o) => { failed.push([id, !!o?.terminal]); },
    };
    return { deps, posted, recorded, completed, failed };
  }

  test('success: posts the result, records bytes against the tools workspace, completes', async () => {
    const h = harness();
    const r = await processToolsJob(job(), h.deps);
    expect(r.ok).toBe(true);
    expect(h.posted).toHaveLength(1);
    expect((h.posted[0] as any).status).toBe('done');
    expect((h.posted[0] as any).requestId).toBe('req-1');
    expect((h.posted[0] as any).result.handle).toBe('creator');
    expect(h.recorded).toEqual([[WS, 1_300_000, 'req-1']]);
    expect(h.completed).toEqual(['job-12345678']);
    expect(h.failed).toEqual([]);
  });

  test('budget refusal posts failed/budget, scrapes nothing, still completes the job', async () => {
    let scraped = false;
    const err = new Error('cap');
    err.name = 'TrafficCapExceededError';
    const h = harness({
      assertBudget: async () => { throw err; },
      resolveCreator: async () => { scraped = true; return null; },
    });
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted).toEqual([{ requestId: 'req-1', status: 'failed', code: 'budget' }]);
    expect(scraped).toBe(false);
    expect(h.completed).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  test('blocked is reported to the breaker as a failure', async () => {
    const h = harness({ resolveCreator: async () => null }, {}, { status: 429, text: '' });
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted).toEqual([{ requestId: 'req-1', status: 'failed', code: 'blocked' }]);
    expect(r.ok).toBe(false);
  });

  test('invalid handle in the payload never reaches the scraper', async () => {
    let scraped = false;
    const h = harness({ assertBudget: async () => { scraped = true; } });
    await processToolsJob(job({ handle: '../etc' }), h.deps);
    expect(scraped).toBe(false);
    expect(h.posted).toEqual([{ requestId: 'req-1', status: 'failed', code: 'not_found' }]);
  });

  test('tools-profile runs the full analysis: 30-post sample, 4 MB budget, fresh identity', async () => {
    const budgets: number[] = [];
    let limit = 0;
    let fresh: boolean | undefined;
    const h = harness({
      assertBudget: async (b) => { budgets.push(b); },
      fetchPosts: async (_i, l) => { limit = l; return Array.from({ length: 30 }, (_, i) => item(i)); },
    });
    const build = h.deps.buildLookup;
    h.deps.buildLookup = (w, onProfile, opts) => { fresh = opts?.fresh; return build(w, onProfile, opts); };
    const r = await processToolsJob(job({ reason: 'refresh' }, 'tools-profile'), h.deps);
    expect(r.ok).toBe(true);
    expect(budgets).toEqual([4 * 1024 * 1024]);
    expect(limit).toBe(30);
    expect(fresh).toBe(true);
    const body = h.posted[0] as any;
    expect(body.status).toBe('done');
    expect(body.result.sampled).toBe(30);
    expect(body.result.medianViews).toBe(2000);
    expect(JSON.stringify(body)).not.toMatch(/tiktokcdn|https?:\/\//);
  });

  test('guards: foreign callback host, foreign workspace, missing secret/workspace', async () => {
    const cases: Array<[ReturnType<typeof job>, Record<string, string>]> = [
      [job({ callbackUrl: 'https://evil.example/x' }), {}],
      [job({}, 'tools-profile-lite', 'someone-else'), {}],
      [job(), { TOOLS_CALLBACK_SECRET: '' }],
      [job(), { TOOLS_WORKSPACE_ID: '' }],
      [job({ requestId: '' }), {}],
    ];
    for (const [j, envOver] of cases) {
      const h = harness({}, envOver);
      const r = await processToolsJob(j, h.deps);
      expect(r.ok).toBe(false);
      expect(h.failed).toEqual([['job-12345678', true]]);
      expect(h.posted).toEqual([]);
    }
  });

  test('undeliverable callback fails the job non-terminally so it retries', async () => {
    const h = harness();
    h.deps.callback.fetch = async () => ({ status: 503 });
    const r = await processToolsJob(job(), h.deps);
    expect(r.ok).toBe(false);
    expect(h.completed).toEqual([]);
    expect(h.failed).toEqual([['job-12345678', false]]);
  });
});
