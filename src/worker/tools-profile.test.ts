import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { median, PROFILE_ESTIMATE_BYTES, runProfile, shapeProfile } from './tools-profile.js';
import type { ProfileLiteDeps } from './tools-jobs.js';

const NOW = new Date('2026-10-25T12:00:00Z');
// 2026-10-20T15:00:00Z = 11:00 US Eastern (EDT)
const BASE = Date.parse('2026-10-20T15:00:00Z') / 1000;

function post(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `70000000000000000${String(i).padStart(2, '0')}`,
    createTime: BASE - i * 86_400,
    desc: `post ${i} #fyp #tips`,
    textExtra: [{ hashtagName: 'FYP' }, { hashtagName: 'tips' }],
    music: { title: 'original sound' },
    video: { duration: 12, cover: 'https://p16.tiktokcdn.com/x.jpeg' },
    stats: { playCount: 1000, diggCount: 100, commentCount: 10, shareCount: 5 },
    ...over,
  };
}

describe('median', () => {
  test('odd, even, empty', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('shapeProfile', () => {
  const id = { followers: 50_000, following: 120, totalLikes: 2_000_000 };

  test('outliers are posts at 3x the median or more, highest first', () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => post(i)),
      post(9, { stats: { playCount: 3000, diggCount: 1, commentCount: 0, shareCount: 0 } }),
      post(10, { stats: { playCount: 9000, diggCount: 1, commentCount: 0, shareCount: 0 } }),
    ];
    const r = shapeProfile(id, 'creator', items, NOW);
    expect(r.medianViews).toBe(1000);
    expect(r.outliers.map((o) => [o.views, o.multiple])).toEqual([[9000, 9], [3000, 3]]);
  });

  test('keeps 30 posts newest first, drops duplicates, totals pass through', () => {
    const items = Array.from({ length: 40 }, (_, i) => post(i));
    const r = shapeProfile(id, 'creator', [...items, items[0]], NOW);
    expect(r.sampled).toBe(30);
    expect(r.posts[0]!.id).toBe(items[0]!.id);
    expect(r.followers).toBe(50_000);
    expect(r.following).toBe(120);
    expect(r.totalLikes).toBe(2_000_000);
  });

  test('cadence: 10 posts a day apart is 7 per week over a 9 day window', () => {
    const r = shapeProfile(id, 'creator', Array.from({ length: 10 }, (_, i) => post(i)), NOW);
    expect(r.windowDays).toBe(9);
    expect(r.postsPerWeek).toBe(7);
  });

  test('best hours use US Eastern and need two posts when any hour has them', () => {
    const items = [
      post(0), post(1), // 11:00 ET, 1000 views each
      post(2, { createTime: BASE - 5 * 3600, stats: { playCount: 50_000, diggCount: 0 } }), // 06:00 ET, a single post
    ];
    const r = shapeProfile(id, 'creator', items, NOW);
    expect(r.bestHours).toEqual([{ hour: 11, posts: 2, avgViews: 1000 }]);
  });

  test('hashtags are lowercased and counted; sounds counted; caption cut at 140 characters', () => {
    const long = 'x'.repeat(300);
    const r = shapeProfile(id, 'creator', [post(0, { desc: long }), post(1), post(2, { music: { title: 'other' } })], NOW);
    expect(r.topHashtags).toEqual([{ tag: 'fyp', count: 3 }, { tag: 'tips', count: 3 }]);
    expect(r.topSounds).toEqual([{ title: 'original sound', count: 2 }, { title: 'other', count: 1 }]);
    expect(r.posts[0]!.caption).toHaveLength(140);
  });

  test('photo posts are flagged and no TikTok URL reaches the result', () => {
    const photo = post(0, { video: { duration: 0, cover: 'https://p16.tiktokcdn.com/tplv-photomode-x.jpeg' } });
    const r = shapeProfile(id, 'creator', [photo, post(1)], NOW);
    expect(r.posts.find((p) => p.id === photo.id)!.isPhotoPost).toBe(true);
    expect(r.posts.find((p) => p.id !== photo.id)!.isPhotoPost).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/tiktokcdn|https?:\/\//);
  });

  test('missing follower count leaves the follower rate null', () => {
    const r = shapeProfile({ followers: null }, 'creator', [post(0), post(1), post(2)], NOW);
    expect(r.erByFollowers).toBeNull();
    expect(r.following).toBeNull();
    expect(r.erByViews).toBe(11.5);
  });

  test('posts without engagement counts never produce a 0% rate', () => {
    const views = { stats: { playCount: 1000, diggCount: 0, commentCount: 0, shareCount: 0 } };
    const r = shapeProfile(id, 'creator', [post(0), post(1), post(2, views), post(3, views)], NOW);
    expect(r.statsSampled).toBe(2);
    expect(r.erByFollowers).toBeNull();
    const none = shapeProfile(id, 'creator', [post(0, views), post(1, views)], NOW);
    expect(none.statsSampled).toBe(0);
    expect(none.erByViews).toBeNull();
    expect(none.avgViews).toBe(1000);
  });
});

describe('runProfile', () => {
  const deps = (over: Partial<ProfileLiteDeps> = {}): ProfileLiteDeps => ({
    assertBudget: async () => {},
    resolveCreator: async () => ({ secUid: 's', handle: 'creator', followers: 50_000 }),
    fetchPosts: async () => Array.from({ length: 30 }, (_, i) => post(i)),
    probe: () => null,
    now: () => NOW,
    ...over,
  });

  test('asks for 4 MB before scraping and maps a refusal to budget', async () => {
    const err = new Error('cap');
    err.name = 'TrafficCapExceededError';
    const seen: number[] = [];
    let scraped = false;
    const out = await runProfile('creator', deps({
      assertBudget: async (b) => { seen.push(b); throw err; },
      resolveCreator: async () => { scraped = true; return null; },
    }));
    expect(out).toEqual({ status: 'failed', code: 'budget' });
    expect(seen).toEqual([PROFILE_ESTIMATE_BYTES]);
    expect(scraped).toBe(false);
  });

  test('an account with no readable posts is not_found', async () => {
    expect(await runProfile('creator', deps({ fetchPosts: async () => [] }))).toEqual({ status: 'failed', code: 'not_found' });
  });

  test('embed first: counts and posts come from one read, the profile page is never opened', async () => {
    let resolved = false;
    const out = await runProfile('creator', deps({
      resolveCreator: async () => { resolved = true; return null; },
      fetchEmbed: async () => ({ identity: { followers: 9_000, following: 5, totalLikes: null }, items: [post(0), post(1)] }),
    }));
    expect(resolved).toBe(false);
    expect(out.status).toBe('done');
    if (out.status === 'done') expect(out.result.followers).toBe(9_000);
  });

  test('an empty embed falls back to the profile path', async () => {
    const out = await runProfile('creator', deps({ fetchEmbed: async () => null }));
    expect(out.status).toBe('done');
    if (out.status === 'done') expect(out.result.followers).toBe(50_000);
  });

  test('hydrate fills engagement, and a failing hydrate keeps the views-only result', async () => {
    const bare = Array.from({ length: 5 }, (_, i) => post(i, { stats: { playCount: 1000, diggCount: 0, commentCount: 0, shareCount: 0 } }));
    const base = { fetchEmbed: async () => ({ identity: { followers: 10_000, following: null, totalLikes: null }, items: bare }) };
    const filled = await runProfile('creator', deps({
      ...base,
      hydrate: async (items) => items.map((it) => ({ ...it, stats: { ...it.stats, diggCount: 100, commentCount: 10, shareCount: 5 } })),
    }));
    if (filled.status !== 'done') throw new Error('expected done');
    expect(filled.result.statsSampled).toBe(5);
    expect(filled.result.erByFollowers).toBe(1.15);
    const failed = await runProfile('creator', deps({ ...base, hydrate: async () => { throw new Error('429'); } }));
    if (failed.status !== 'done') throw new Error('expected done');
    expect(failed.result.statsSampled).toBe(0);
    expect(failed.result.erByFollowers).toBeNull();
    expect(failed.result.erByViews).toBeNull();
  });
});
