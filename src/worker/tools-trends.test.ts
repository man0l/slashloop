import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { canonicalString, hmacSign, SLQ_HEADERS, verifyAuth, mapKeyStore } from '../queue/auth.js';
import { ApifyRunError, mapCreativeCenterItems, runCostCents, runApifyActor, type ApifyDeps } from '../lib/apify-trends.js';
import { processToolsJob, type ToolsJobDeps } from './tools-jobs.js';
import {
  mapSampleItem,
  parseTrendsPayload,
  pickSampleTags,
  runTrends,
  type TrendsDeps,
} from './tools-trends.js';

const NOW = new Date('2026-10-26T06:00:00Z');
const CALLBACK = 'https://slashloop.dev/tools/api/trends/ingest';

// Shape of the merged Creative Center actor output: one row per hashtag and
// period, every list the tag ranks in under `lists`, plus the top-creators
// fields we must never forward.
const ACTOR_ITEMS = [
  {
    record_id: 'hashtag_us_7_fyp',
    hashtag_name: 'fyp',
    period: 7,
    posts: 1200000,
    views: 98000000000,
    trend_direction: 'up',
    trend_momentum_pct: 12.5,
    popularity_curve: [{ time: 1, value: 80 }, { time: 2, value: '95' }],
    industries: ['Beauty & Personal Care'],
    lists: [{ list: 'overall', rank: 1 }, { list: 'Beauty & Personal Care', rank: 2 }],
    top_creators: [{ nickname: 'Someone', avatar: 'https://x/a.jpg' }],
  },
  {
    record_id: 'hashtag_us_7_skincare',
    hashtag_name: '#SkinCare',
    period: 7,
    posts: 50000,
    views: 700000000,
    trend_direction: 'flat',
    trend_momentum_pct: null,
    popularity_curve: [],
    industries: ['Beauty & Personal Care'],
    lists: [{ list: 'Beauty & Personal Care', rank: 1 }],
    top_creators: [],
  },
  { record_id: 'not_listed_x', row_type: 'not_listed', hashtag_name: 'ghost', period: 7, lists: [] },
  {
    record_id: 'hashtag_us_30_fyp',
    hashtag_name: 'fyp',
    period: 30,
    posts: 4000000,
    views: 5,
    trend_direction: 'down',
    lists: [{ list: 'overall', rank: 3 }],
  },
  { record_id: 'hashtag_us_90_old', hashtag_name: 'old', period: 90, lists: [{ list: 'overall', rank: 1 }] },
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

describe('mapCreativeCenterItems (actor fixture)', () => {
  const out = mapCreativeCenterItems(ACTOR_ITEMS);

  test('one record per tag, list and period; 90-day and not-listed rows dropped', () => {
    expect(out.map((h) => `${h.tag}|${h.scope}|${h.period}|${h.rank}`)).toEqual([
      'fyp|overall|7|1',
      'fyp|Beauty & Personal Care|7|2',
      'skincare|Beauty & Personal Care|7|1',
      'fyp|overall|30|3',
    ]);
  });

  test('keeps the required fields and coerces numeric strings in the curve', () => {
    const first = out[0]!;
    expect(first).toEqual({
      tag: 'fyp', scope: 'overall', period: 7, rank: 1, mergedRank: 1,
      posts: 1200000, views: 98000000000, curve: [80, 95],
      trendDirection: 'rising', momentumPct: 12.5,
      industries: ['Beauty & Personal Care'], creators: null,
    });
    const flat = out.find((h) => h.tag === 'skincare')!;
    expect(flat.trendDirection).toBe('stable');
    expect(flat.momentumPct).toBeNull();
    expect(flat.mergedRank).toBe(2);
    expect(out.find((h) => h.period === 30)!.trendDirection).toBe('falling');
  });

  test('never carries top-creator fields', () => {
    expect(JSON.stringify(out)).not.toMatch(/top_creators|Someone|avatar/);
  });

  test('an error row from the actor is surfaced', () => {
    expect(() => mapCreativeCenterItems([{ error: true, code: 'invalid_input' }])).toThrow(/invalid_input/);
  });
});

describe('runCostCents', () => {
  test('uses the larger of platform usage and pay-per-event charges, rounded up', () => {
    expect(runCostCents({ usageTotalUsd: 0.002, chargedEventCounts: { item: 100 }, pricingInfo: { pricingPerEvent: { actorChargeEvents: { item: { eventPriceUsd: 0.0017 } } } } })).toBe(17);
    expect(runCostCents({ usageTotalUsd: 0.001 })).toBe(1);
    expect(runCostCents({})).toBe(0);
  });
});

describe('runApifyActor', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  test('starts, polls to a terminal status and reads the dataset with a bearer header', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const answers = [
      json({ data: { id: 'run1', status: 'RUNNING' } }),
      json({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.18 } }),
      json([{ hashtag_name: 'fyp' }]),
    ];
    const deps: ApifyDeps = {
      fetch: async (url, init) => {
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return answers.shift()!;
      },
      sleep: async () => {},
      now: () => 0,
    };
    const run = await runApifyActor('apify-secret-xyz', 'hyperbach/tiktok-creative-center-scraper', { a: 1 }, deps);
    expect(run.costCents).toBe(18);
    expect(run.items).toEqual([{ hashtag_name: 'fyp' }]);
    expect(calls[0]!.url).toContain('/acts/hyperbach~tiktok-creative-center-scraper/runs');
    expect(calls[0]!.url).toContain('maxTotalChargeUsd=0.25');
    expect(calls.every((c) => c.auth === 'Bearer apify-secret-xyz')).toBe(true);
    expect(calls.some((c) => c.url.includes('apify-secret-xyz'))).toBe(false);
  });

  test('a failed run throws with the billed cents attached', async () => {
    const deps: ApifyDeps = {
      fetch: async () => json({ data: { id: 'r', status: 'FAILED', usageTotalUsd: 0.04 } }),
      sleep: async () => {},
      now: () => 0,
    };
    const err = await runApifyActor('tok', 'a/b', {}, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ApifyRunError);
    expect(err.costCents).toBe(4);
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
    const hs = mapCreativeCenterItems(ACTOR_ITEMS);
    expect(pickSampleTags(hs, 7, 20)).toEqual(['fyp', 'skincare']);
    expect(pickSampleTags(hs, 7, 1)).toEqual(['fyp']);
  });
});

function trendsDeps(over: Partial<TrendsDeps> = {}): TrendsDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    assertBudget: async (b) => { log.push(`budget:${b}`); },
    runActor: async () => { log.push('actor'); return { runId: 'r', status: 'SUCCEEDED', costCents: 18, items: ACTOR_ITEMS }; },
    recordApifySpend: async (c, r) => { log.push(`spend:${c}:${r}`); },
    resolveChallengeId: async (t) => { log.push(`resolve:${t}`); return `1${t.length}000`; },
    fetchTagPosts: async (t) => { log.push(`posts:${t}`); return [{ id: `${t}-1`, music: { id: 'm', title: 's', authorName: 'a' }, stats: { playCount: 5 }, video: { duration: 9 } }]; },
    now: () => NOW,
    ...over,
  };
}

describe('runTrends', () => {
  const payload = { requestId: 'req-1', callbackUrl: CALLBACK, country: 'US' as const, periods: [7, 30], sampleTags: 20 };

  test('happy path: actor, spend, then one sample per tag', async () => {
    const d = trendsDeps();
    const o = await runTrends(payload, d);
    expect(o.status).toBe('done');
    if (o.status !== 'done') return;
    expect(o.body.takenAt).toBe(NOW.toISOString());
    expect(o.body.hashtags).toHaveLength(4);
    expect(o.body.samplePosts.map((p) => p.id)).toEqual(['fyp-1', 'skincare-1']);
    expect(o.sampledTags).toBe(2);
    expect(d.log[0]).toBe(`budget:${20 * 200 * 1024}`);
    expect(d.log.indexOf('actor')).toBeGreaterThan(0);
    expect(d.log).toContain('spend:18:req-1');
  });

  test('budget guard fails with code budget before any actor run or fetch', async () => {
    const err = new Error('cap');
    err.name = 'TrafficCapExceededError';
    const d = trendsDeps({ assertBudget: async () => { throw err; } });
    expect(await runTrends(payload, d)).toEqual({ status: 'failed', code: 'budget' });
    expect(d.log).toEqual([]);
  });

  test('actor failure retries once, records both runs, then fails with code actor', async () => {
    let runs = 0;
    const d = trendsDeps({
      runActor: async () => { runs++; throw new ApifyRunError('apify run failed', 3); },
    });
    expect(await runTrends(payload, d)).toEqual({ status: 'failed', code: 'actor' });
    expect(runs).toBe(2);
    expect(d.log.filter((l) => l.startsWith('spend:3'))).toHaveLength(2);
    expect(d.log.some((l) => l.startsWith('resolve:'))).toBe(false);
  });

  test('a flaky first actor run succeeds on the retry', async () => {
    let runs = 0;
    const d = trendsDeps({
      runActor: async () => {
        runs++;
        if (runs === 1) throw new ApifyRunError('apify 503', 0);
        return { runId: 'r2', status: 'SUCCEEDED', costCents: 18, items: ACTOR_ITEMS };
      },
    });
    expect((await runTrends(payload, d)).status).toBe('done');
    expect(runs).toBe(2);
  });

  test('sampling stops after three tags in a row fail but the ranking still ships', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      record_id: `h${i}`, hashtag_name: `tag${i}`, period: 7, posts: 1, lists: [{ list: 'overall', rank: i + 1 }],
    }));
    let actorRuns = 0;
    let resolves = 0;
    const d = trendsDeps({
      runActor: async () => { actorRuns++; return { runId: 'r', status: 'SUCCEEDED', costCents: 5, items: many }; },
      resolveChallengeId: async () => { resolves++; return null; },
    });
    const o = await runTrends({ ...payload, periods: [7] }, d);
    expect(o.status).toBe('done');
    if (o.status !== 'done') return;
    expect(o.body.hashtags).toHaveLength(8);
    expect(o.body.samplePosts).toEqual([]);
    expect(actorRuns).toBe(1);
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
      env: { TOOLS_WORKSPACE_ID: WS, TOOLS_CALLBACK_SECRET: SECRET } as NodeJS.ProcessEnv,
      now: () => NOW,
      measure: async (fn) => ({ value: await fn(), bytes: 3_600_000 }),
      buildLookup: () => { throw new Error('profile lookup must not be built for tools-trends'); },
      buildTrends: () => trends,
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
    expect(body.hashtags).toHaveLength(4);
    expect(body.samplePosts).toHaveLength(2);
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

  test('actor failure posts failed/actor and reports the kind as unhealthy', async () => {
    const h = harness(trendsDeps({ runActor: async () => { throw new ApifyRunError('apify run failed', 0); } }));
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted[0]!.body).toEqual({ requestId: 'req-1', status: 'failed', code: 'actor' });
    expect(r.ok).toBe(false);
  });

  test('invalid payload and foreign workspace never reach the actor', async () => {
    const d = trendsDeps();
    const h = harness(d);
    expect((await processToolsJob(job({ periods: [90] }), h.deps)).ok).toBe(false);
    expect((await processToolsJob(job({}, 'ws-other'), h.deps)).ok).toBe(false);
    expect(d.log).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.failed.every(([, terminal]) => terminal)).toBe(true);
  });
});
