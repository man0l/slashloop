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
  CC_INDUSTRIES,
  CC_LIST_LIMIT,
  CreativeCenterError,
  curveMomentum,
  fetchHashtagList,
  mapHashtagLists,
  type ListResult,
} from '../lib/creative-center.js';
import { processToolsJob, type ToolsJobDeps } from './tools-jobs.js';
import {
  mapSampleItem,
  listBytesEstimate,
  parseTrendsPayload,
  pickSampleTags,
  runTrends,
  type TrendsDeps,
} from './tools-trends.js';

const NOW = new Date('2026-10-26T06:00:00Z');
const CALLBACK = 'https://slashloop.dev/tools/api/trends/ingest';

// Raw Creative Center list items (GetHashtagList): numbers arrive as strings,
// topCreators carries handles and avatars we must never forward.
const rawItem = (name: string, rank: number, posts: number, curve: number[], industryIDs: string[] = []) => ({
  hashtagID: `id-${name}`,
  hashtagName: name,
  rankIndex: String(rank),
  publishCnt: String(posts),
  vv: String(posts * 1000),
  industryIDs,
  popularityCurve: curve.map((value, i) => ({ timestamp: String(1_790_000_000 + i * 86400), value })),
  topCreators: [{ handleName: 'someone.private', nickname: 'Someone', avatarURL: 'https://x/a.jpg', ttUID: '1' }],
});
const BEAUTY = CC_INDUSTRIES.find((i) => i.name === 'Beauty & Personal Care')!;
const LISTS: ListResult[] = [
  {
    period: 7, scope: 'overall',
    items: [
      rawItem('fyp', 1, 1_200_000, [10, 20, 40, 60, 80, 90, 100]),
      rawItem('SkinCare', 2, 50_000, [50, 50, 50, 50, 50, 50, 50], [BEAUTY.id]),
      rawItem('chaos', 3, 900, [0, 0, 0, 5, 10, 40, 100]),
    ],
  },
  { period: 7, scope: 'Beauty & Personal Care', items: [rawItem('skincare', 1, 50_000, [50, 50, 50, 50, 50, 50, 50], [BEAUTY.id]), rawItem('glow', 2, 700, [100, 80, 60, 40, 20, 10, 0], [BEAUTY.id])] },
  { period: 30, scope: 'overall', items: [rawItem('fyp', 1, 4_000_000, [1, 2, 3, 4])] },
];

describe('parseTrendsPayload', () => {
  const ok = { requestId: 'req-1', callbackUrl: CALLBACK, country: 'US' as const, periods: [30, 7], sampleTags: 20 };

  test('accepts the cron payload and sorts periods', () => {
    expect(parseTrendsPayload(JSON.stringify(ok))).toEqual({ ...ok, periods: [7, 30] });
  });

  test.each([
    ['bad json', '{'],
    ['no request id', JSON.stringify({ ...ok, requestId: '../x' })],
    ['other country', JSON.stringify({ ...ok, country: 'GB' })],
    ['90 day period', JSON.stringify({ ...ok, periods: [7, 90] })],
    ['no periods', JSON.stringify({ ...ok, periods: [] })],
    ['too many sample tags', JSON.stringify({ ...ok, sampleTags: 21 })],
    ['fractional sample tags', JSON.stringify({ ...ok, sampleTags: 2.5 })],
  ])('rejects %s', (_n, raw) => {
    expect('error' in (parseTrendsPayload(raw) as object)).toBe(true);
  });
});

describe('mapHashtagLists (list fixture)', () => {
  const out = mapHashtagLists(LISTS, [7, 30]);

  test('one record per tag, list and period', () => {
    expect(out.map((h) => `${h.tag}|${h.scope}|${h.period}|${h.rank}|${h.mergedRank}`)).toEqual([
      'fyp|overall|7|1|1',
      'skincare|overall|7|2|2',
      'skincare|Beauty & Personal Care|7|1|2',
      'chaos|overall|7|3|3',
      'glow|Beauty & Personal Care|7|2|4',
      'fyp|overall|30|1|1',
    ]);
  });

  test('keeps rank, posts, views, curve and industries; coerces string numbers', () => {
    expect(out[0]).toEqual({
      tag: 'fyp', scope: 'overall', period: 7, rank: 1, mergedRank: 1,
      posts: 1_200_000, views: 1_200_000_000, curve: [10, 20, 40, 60, 80, 90, 100],
      trendDirection: 'rising', momentumPct: 285.7, industries: [], creators: null,
    });
    const skin = out.find((h) => h.tag === 'skincare')!;
    expect(skin.industries).toEqual(['Beauty & Personal Care']);
    expect(skin.trendDirection).toBe('stable');
    expect(out.find((h) => h.tag === 'glow')!.trendDirection).toBe('falling');
  });

  test('never carries top-creator fields', () => {
    expect(JSON.stringify(out)).not.toMatch(/topCreators|someone|Someone|avatar|handleName/);
  });
});

describe('curveMomentum', () => {
  test('compares the second half of the curve with the first', () => {
    expect(curveMomentum([10, 10, 20, 20])).toEqual({ direction: 'rising', pct: 100 });
    expect(curveMomentum([20, 20, 10, 10])).toEqual({ direction: 'falling', pct: -50 });
    expect(curveMomentum([10, 10, 10, 10])).toEqual({ direction: 'stable', pct: 0 });
    expect(curveMomentum([0, 0, 5, 9])).toEqual({ direction: 'rising', pct: null });
    expect(curveMomentum([1, 2])).toEqual({ direction: null, pct: null });
  });
});

describe('CC_INDUSTRIES', () => {
  test('21 distinct top-level industries', () => {
    expect(CC_INDUSTRIES).toHaveLength(21);
    expect(new Set(CC_INDUSTRIES.map((i) => i.id)).size).toBe(21);
    expect(CC_INDUSTRIES.every((i) => /^\d\d000000000$/.test(i.id))).toBe(true);
  });
});

describe('fetchHashtagList', () => {
  const reply = (text: string, status = 200) => async () => ({ status, ok: status < 400, text });

  test('posts the unsigned request body and returns items', async () => {
    const seen: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const post = async (url: string, body: string, headers: Record<string, string>) => {
      seen.push({ url, body: JSON.parse(body), headers });
      return { status: 200, ok: true, text: JSON.stringify({ BaseResp: { StatusCode: 0 }, items: [{ hashtagName: 'a' }] }) };
    };
    expect(await fetchHashtagList(7, BEAUTY.id, post)).toEqual([{ hashtagName: 'a' }]);
    await fetchHashtagList(30, null, post);
    expect(seen[0]!.url).toBe('https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList');
    expect(seen[0]!.body).toEqual({ timeRange: 7, countryCode: 'US', industryID: BEAUTY.id, page: 1, limit: CC_LIST_LIMIT });
    expect(seen[1]!.body).toEqual({ timeRange: 30, countryCode: 'US', page: 1, limit: CC_LIST_LIMIT });
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['accept', 'agw-js-conv', 'content-type']);
  });

  test('http errors, non-JSON bodies and non-zero StatusCode throw CreativeCenterError', async () => {
    for (const post of [
      reply('{}', 500),
      reply('<html>'),
      reply(JSON.stringify({ BaseResp: { StatusCode: 10001 } })),
    ]) {
      expect(await fetchHashtagList(7, null, post).catch((e) => e)).toBeInstanceOf(CreativeCenterError);
    }
  });

  test('a body without items is an empty list', async () => {
    expect(await fetchHashtagList(7, null, reply(JSON.stringify({ BaseResp: { StatusCode: 0 } })))).toEqual([]);
  });
});

describe('mapSampleItem (sampler fixture)', () => {
  const raw = {
    id: '7400000000000000001',
    desc: 'x'.repeat(500),
    createTime: 1_761_000_000,
    author: { uniqueId: 'creator.one', nickname: 'Creator One', signature: 'private bio' },
    authorStats: { followerCount: 99 },
    music: { id: '7300000000000000009', title: 'original sound', authorName: 'creator.one', playUrl: 'https://cdn/x.mp3' },
    stats: { playCount: 123456, diggCount: 9 },
    video: { duration: 14, cover: 'https://cdn/c.jpg', playAddr: 'https://cdn/v.mp4' },
  };

  test('keeps exactly the ten fields', () => {
    const p = mapSampleItem(raw, 'fyp')!;
    expect(Object.keys(p).sort()).toEqual(
      ['author', 'createTime', 'desc', 'durationSec', 'id', 'isPhoto', 'playCount', 'soundAuthor', 'soundId', 'soundTitle', 'tag'],
    );
    expect(p).toMatchObject({
      id: '7400000000000000001', tag: 'fyp', createTime: 1_761_000_000,
      soundId: '7300000000000000009', soundTitle: 'original sound', soundAuthor: 'creator.one',
      playCount: 123456, author: 'creator.one', durationSec: 14, isPhoto: false,
    });
    expect(p.desc).toHaveLength(300);
    expect(JSON.stringify(p)).not.toMatch(/cdn|private bio|followerCount/);
  });

  test('photo carousels are flagged and items without an id are dropped', () => {
    const photo = { ...raw, video: { duration: 0, cover: 'https://cdn/tplv-photomode.jpg' } };
    expect(mapSampleItem(photo, 'fyp')!.isPhoto).toBe(true);
    expect(mapSampleItem({ ...raw, id: undefined }, 'fyp')).toBeNull();
  });
});

describe('pickSampleTags', () => {
  test('orders by merged rank, de-duplicates across scopes and caps', () => {
    const hs = mapHashtagLists(LISTS, [7, 30]);
    expect(pickSampleTags(hs, 7, 20)).toEqual(['fyp', 'skincare', 'chaos', 'glow']);
    expect(pickSampleTags(hs, 7, 1)).toEqual(['fyp']);
  });
});

function trendsDeps(over: Partial<TrendsDeps> = {}): TrendsDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    assertBudget: async (b) => { log.push(`budget:${b}`); },
    fetchHashtagList: async (period, industryId) => {
      log.push(`list:${period}:${industryId ?? 'overall'}`);
      const scope = industryId === null ? 'overall' : CC_INDUSTRIES.find((i) => i.id === industryId)!.name;
      return LISTS.find((l) => l.period === period && l.scope === scope)?.items ?? [];
    },
    resolveChallengeId: async (t) => { log.push(`resolve:${t}`); return `1${t.length}000`; },
    fetchTagPosts: async (t) => { log.push(`posts:${t}`); return [{ id: `${t}-1`, music: { id: 'm', title: 's', authorName: 'a' }, stats: { playCount: 5 }, video: { duration: 9 } }]; },
    now: () => NOW,
    ...over,
  };
}

describe('runTrends', () => {
  const payload = { requestId: 'req-1', callbackUrl: CALLBACK, country: 'US' as const, periods: [7, 30], sampleTags: 20 };

  test('happy path: budget first, overall plus every industry per period, then one sample per tag', async () => {
    const d = trendsDeps();
    const o = await runTrends(payload, d);
    expect(o.status).toBe('done');
    if (o.status !== 'done') return;
    expect(o.body.takenAt).toBe(NOW.toISOString());
    expect(o.body.hashtags).toHaveLength(6);
    expect(o.body.samplePosts.map((p) => p.id)).toEqual(['fyp-1', 'skincare-1', 'chaos-1', 'glow-1']);
    expect(o.sampledTags).toBe(4);
    expect(d.log[0]).toBe(`budget:${listBytesEstimate(2) + 20 * 200 * 1024}`);
    expect(d.log.filter((l) => l.startsWith('list:'))).toHaveLength(2 * (CC_INDUSTRIES.length + 1));
    expect(d.log.indexOf('resolve:fyp')).toBeGreaterThan(d.log.lastIndexOf(`list:30:${CC_INDUSTRIES[20]!.id}`));
  });

  test('budget guard fails with code budget before any fetch', async () => {
    const err = new Error('cap');
    err.name = 'TrafficCapExceededError';
    const d = trendsDeps({ assertBudget: async () => { throw err; } });
    expect(await runTrends(payload, d)).toEqual({ status: 'failed', code: 'budget' });
    expect(d.log).toEqual([]);
  });

  test('an unreadable overall list retries once then fails with code source and samples nothing', async () => {
    let calls = 0;
    const d = trendsDeps({
      fetchHashtagList: async () => { calls++; throw new CreativeCenterError('creative center http 503'); },
    });
    expect(await runTrends(payload, d)).toEqual({ status: 'failed', code: 'source' });
    expect(calls).toBe(2);
    expect(d.log.some((l) => l.startsWith('resolve:'))).toBe(false);
  });

  test('a flaky list succeeds on the retry', async () => {
    let first = true;
    const base = trendsDeps();
    const d = trendsDeps({
      fetchHashtagList: async (p, i) => {
        if (first) { first = false; throw new CreativeCenterError('creative center http 503'); }
        return base.fetchHashtagList(p, i);
      },
    });
    expect((await runTrends(payload, d)).status).toBe('done');
  });

  test('an industry list that keeps failing is skipped; the ranking still ships', async () => {
    const base = trendsDeps();
    const d = trendsDeps({
      fetchHashtagList: async (p, i) => {
        if (i === BEAUTY.id) throw new CreativeCenterError('creative center status 10001');
        return base.fetchHashtagList(p, i);
      },
    });
    const o = await runTrends(payload, d);
    expect(o.status).toBe('done');
    if (o.status !== 'done') return;
    expect(o.body.hashtags.map((h) => h.tag).sort()).toEqual(['chaos', 'fyp', 'fyp', 'skincare']);
  });

  test('sampling stops after three tags in a row fail but the ranking still ships', async () => {
    const many: ListResult[] = [{
      period: 7, scope: 'overall',
      items: Array.from({ length: 8 }, (_, i) => rawItem(`tag${i}`, i + 1, 10, [1, 2, 3, 4])),
    }];
    let resolves = 0;
    const d = trendsDeps({
      fetchHashtagList: async (p, i) => (i === null && p === 7 ? many[0]!.items : []),
      resolveChallengeId: async () => { resolves++; return null; },
    });
    const o = await runTrends({ ...payload, periods: [7] }, d);
    expect(o.status).toBe('done');
    if (o.status !== 'done') return;
    expect(o.body.hashtags).toHaveLength(8);
    expect(o.body.samplePosts).toEqual([]);
    expect(resolves).toBe(3);
  });
});

describe('processToolsJob: tools-trends', () => {
  const WS = 'ws-tools';
  const SECRET = 'shh';
  const job = (over: Record<string, unknown> = {}, workspaceId = WS) => ({
    id: 'job-trends-1',
    kind: 'tools-trends',
    workspaceId,
    payloadJson: JSON.stringify({ requestId: 'req-1', callbackUrl: CALLBACK, country: 'US', periods: [7, 30], sampleTags: 20, ...over }),
  });

  function harness(trends: TrendsDeps) {
    const posted: Array<{ body: any; headers: Record<string, string>; raw: string }> = [];
    const recorded: Array<[string, number, string]> = [];
    const completed: string[] = [];
    const failed: Array<[string, boolean]> = [];
    const deps: ToolsJobDeps = {
      env: { TOOLS_WORKSPACE_ID: WS, TOOLS_CALLBACK_SECRET: SECRET, TOOLS_CALLBACK_ALLOWED_HOSTS: 'mcp.slashloop.dev,slashloop.dev' } as NodeJS.ProcessEnv,
      now: () => NOW,
      measure: async (fn) => ({ value: await fn(), bytes: 3_600_000 }),
      buildLookup: () => { throw new Error('profile lookup must not be built for tools-trends'); },
      buildTrends: () => trends,
      buildVideo: () => { throw new Error('video deps must not be built for tools-trends'); },
      recordBytes: async (w, b, r) => { recorded.push([w, b, r]); },
      callback: {
        fetch: async (_u, init) => { posted.push({ body: JSON.parse(init.body), headers: init.headers, raw: init.body }); return { status: 204 }; },
        nowSeconds: () => 1_761_000_000,
        nonce: () => 'nonce-1',
        sleep: async () => {},
      },
      completeJob: async (id) => { completed.push(id); },
      failJob: async (id, _m, o) => { failed.push([id, !!o?.terminal]); },
    };
    return { deps, posted, recorded, completed, failed };
  }

  test('posts one signed snapshot, bills bytes to the tools workspace, completes', async () => {
    const h = harness(trendsDeps());
    const r = await processToolsJob(job(), h.deps);
    expect(r.ok).toBe(true);
    expect(h.posted).toHaveLength(1);
    const { body, headers, raw } = h.posted[0]!;
    expect(body).toMatchObject({ requestId: 'req-1', status: 'done', country: 'US', takenAt: NOW.toISOString() });
    expect(body.hashtags).toHaveLength(6);
    expect(body.samplePosts).toHaveLength(4);
    expect(h.recorded).toEqual([[WS, 3_600_000, 'req-1']]);
    expect(h.completed).toEqual(['job-trends-1']);

    const expected = hmacSign(SECRET, canonicalString('POST', '/tools/api/trends/ingest', '1761000000', 'nonce-1', raw));
    expect(headers[SLQ_HEADERS.signature]).toBe(expected);
    const verified = verifyAuth(
      { ...headers, [SLQ_HEADERS.keyId]: 'k' },
      'POST',
      '/tools/api/trends/ingest',
      raw,
      mapKeyStore([{ keyId: 'k', secret: SECRET, state: 'active' }]),
      1_761_000_000,
    );
    expect(verified.ok).toBe(true);
  });

  test('budget refusal posts failed/budget and still completes the job', async () => {
    const err = new Error('cap');
    err.name = 'SpendCapExceededError';
    const d = trendsDeps({ assertBudget: async () => { throw err; } });
    const h = harness(d);
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted[0]!.body).toEqual({ requestId: 'req-1', status: 'failed', code: 'budget' });
    expect(d.log).toEqual([]);
    expect(h.completed).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  test('source failure posts failed/source and reports the kind as unhealthy', async () => {
    const h = harness(trendsDeps({ fetchHashtagList: async () => { throw new CreativeCenterError('creative center http 503'); } }));
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted[0]!.body).toEqual({ requestId: 'req-1', status: 'failed', code: 'source' });
    expect(r.ok).toBe(false);
  });

  test('invalid payload and foreign workspace never reach the source', async () => {
    const d = trendsDeps();
    const h = harness(d);
    expect((await processToolsJob(job({ periods: [90] }), h.deps)).ok).toBe(false);
    expect((await processToolsJob(job({}, 'ws-other'), h.deps)).ok).toBe(false);
    expect(d.log).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.failed.every(([, terminal]) => terminal)).toBe(true);
  });
});
