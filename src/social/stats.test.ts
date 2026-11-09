import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { setActiveClient } from '../store.js';
import { saveMetrics } from './store.js';
import { bucketStart, bucketStarts, carryForwardMetrics, getSocialStats, parseStatsQuery, type StatsQuery } from './stats.js';
import { GET } from '../../api/social-stats.js';

let db: Database;

const migration = (f: string) => db.exec(readFileSync(new URL(`../../prisma/d1-migrations/${f}`, import.meta.url), 'utf8'));
const epoch = (iso: string) => Date.parse(iso) / 1000;

function addIntegration(id: string, owner: string, provider: string, tags: string | null = null) {
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, profile, name, token, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'x', ?, 0, 0)`,
    [id, owner, provider, id, `${id}_handle`, `${id} name`, tags],
  );
}

function addPost(id: string, integration: string, opts: { owner?: string; publishedAt?: string; state?: string; views?: number | null } = {}) {
  db.run(
    `INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, attempts, created_at, updated_at, published_at, views)
     VALUES (?, 'g', ?, ?, 'youtube', ?, 0, 'x', 0, 0, 0, ?, ?)`,
    [id, opts.owner ?? 'alice', integration, opts.state ?? 'PUBLISHED', opts.publishedAt ? epoch(opts.publishedAt) : null, opts.views ?? null],
  );
}

function snap(post: string, day: string, views: number | null) {
  db.run('INSERT INTO social_post_metrics_daily (post_id, day, views, synced_at) VALUES (?, ?, ?, ?)', [post, day, views, epoch(`${day}T12:00:00Z`)]);
}

const Q: StatsQuery = { from: '2026-11-01', to: '2026-11-14', bucket: 'day', mode: 'gained' };
const series = async (q: Partial<StatsQuery> = {}, owners = ['alice']) => {
  const r = await getSocialStats(owners, { ...Q, ...q });
  return Object.fromEntries(r.buckets.map((b) => [b.start, b.byAccount]));
};

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of ['0005_social_scheduler.sql', '0025_social_lanes.sql', '0026_social_post_metrics.sql', '0027_social_post_more_metrics.sql', '0030_social_post_retention.sql', '0031_social_post_metrics_daily.sql']) migration(f);
  setActiveClient({} as never, async (statements) => statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]));
  addIntegration('yt', 'alice', 'youtube', '["lane:spoon","primary"]');
  addIntegration('ig', 'alice', 'instagram');
  addIntegration('yt-bob', 'bob', 'youtube');
});
afterEach(() => db.close());

describe('buckets', () => {
  test('weeks start Monday, months on the 1st', () => {
    expect(bucketStart('2026-11-08', 'week')).toBe('2026-11-02'); // Sunday → previous Monday
    expect(bucketStart('2026-11-09', 'week')).toBe('2026-11-09'); // Monday
    expect(bucketStart('2026-11-15', 'week')).toBe('2026-11-09');
    expect(bucketStart('2026-11-30', 'month')).toBe('2026-11-01');
    expect(bucketStart('2026-11-30', 'day')).toBe('2026-11-30');
  });

  test('bucketStarts is continuous across month and year ends', () => {
    expect(bucketStarts('2026-12-30', '2027-01-02', 'day')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(bucketStarts('2026-11-04', '2026-11-20', 'week')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(bucketStarts('2026-11-15', '2027-02-02', 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  });
});

describe('parseStatsQuery', () => {
  const now = Date.parse('2026-11-10T08:00:00Z');

  test('defaults to the last 30 days, per day, gained', () => {
    expect(parseStatsQuery({}, now)).toEqual({ ok: true, query: { from: '2026-10-12', to: '2026-11-10', bucket: 'day', mode: 'gained', accounts: undefined } });
  });

  test('rejects ranges over 400 days, accepts exactly 400', () => {
    expect(parseStatsQuery({ from: '2025-01-01', to: '2026-11-10' }, now)).toMatchObject({ ok: false, error: 'range_too_large' });
    expect(parseStatsQuery({ from: '2025-10-07', to: '2026-11-10' }, now)).toMatchObject({ ok: true }); // 400 days inclusive
    expect(parseStatsQuery({ from: '2025-10-06', to: '2026-11-10' }, now)).toMatchObject({ ok: false });
  });

  test('rejects bad dates, inverted ranges, unknown bucket/mode', () => {
    expect(parseStatsQuery({ from: '2026-13-01', to: '2026-11-10' }, now)).toMatchObject({ ok: false, error: 'invalid_range' });
    expect(parseStatsQuery({ from: '2026-02-30', to: '2026-11-10' }, now)).toMatchObject({ ok: false, error: 'invalid_range' });
    expect(parseStatsQuery({ from: '2026-11-10', to: '2026-11-01' }, now)).toMatchObject({ ok: false, error: 'invalid_range' });
    expect(parseStatsQuery({ bucket: 'year' }, now)).toMatchObject({ ok: false, error: 'invalid_bucket' });
    expect(parseStatsQuery({ mode: 'likes' }, now)).toMatchObject({ ok: false, error: 'invalid_mode' });
  });

  test('splits and de-duplicates the accounts list', () => {
    expect(parseStatsQuery({ accounts: 'a, b,a,' }, now)).toMatchObject({ ok: true, query: { accounts: ['a', 'b'] } });
  });
});

describe('gained', () => {
  test('first snapshot is a baseline (0) when the post was published earlier', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-20T10:00:00Z' });
    snap('p1', '2026-11-03', 1000);
    snap('p1', '2026-11-04', 1100);
    const s = await series();
    expect(s['2026-11-03']!.yt).toBe(0);
    expect(s['2026-11-04']!.yt).toBe(100);
  });

  test('first snapshot counts in full when published that same UTC day', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-11-03T23:30:00Z' });
    snap('p1', '2026-11-03', 250);
    snap('p1', '2026-11-04', 400);
    const s = await series();
    expect(s['2026-11-03']!.yt).toBe(250);
    expect(s['2026-11-04']!.yt).toBe(150);
  });

  test('a decrease clamps to 0, and the next gain measures from the lower value', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-11-02', 500);
    snap('p1', '2026-11-03', 480);
    snap('p1', '2026-11-04', 530);
    const s = await series();
    expect(s['2026-11-03']!.yt).toBe(0);
    expect(s['2026-11-04']!.yt).toBe(50);
  });

  test('the delta at the range start uses the snapshot before the range', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-10-31', 900);
    snap('p1', '2026-11-01', 940);
    expect((await series({ from: '2026-11-01' }))['2026-11-01']!.yt).toBe(40);
  });

  test('a carried-forward snapshot gains 0 and the next real one gains the difference', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-11-02', 100);
    snap('p1', '2026-11-03', 100);
    snap('p1', '2026-11-04', 130);
    const s = await series();
    expect([s['2026-11-03']!.yt, s['2026-11-04']!.yt]).toEqual([0, 30]);
  });

  test('sums posts per account and per bucket, emitting empty buckets as zeros', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    addPost('p2', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    addPost('p3', 'ig', { publishedAt: '2026-10-01T00:00:00Z' });
    for (const [p, a, b] of [['p1', 10, 30], ['p2', 5, 10], ['p3', 1, 8]] as const) {
      snap(p, '2026-11-03', a);
      snap(p, '2026-11-04', b);
    }
    const day = await series();
    expect(day['2026-11-04']).toEqual({ yt: 25, ig: 7 });
    expect(day['2026-11-08']).toEqual({ yt: 0, ig: 0 });
    expect(Object.keys(day)).toHaveLength(14);

    // 2026-11-03 is a Tuesday → week of Mon 11-02; both snapshots fall in it.
    const week = await series({ bucket: 'week', from: '2026-11-02', to: '2026-11-15' });
    expect(Object.keys(week)).toEqual(['2026-11-02', '2026-11-09']);
    expect(week['2026-11-02']).toEqual({ yt: 25, ig: 7 });
    expect((await series({ bucket: 'month', from: '2026-10-15', to: '2026-11-30' }))['2026-11-01']).toEqual({ yt: 25, ig: 7 });
  });

  test('the accounts filter limits the result, ignoring ids the caller cannot see', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    addPost('p3', 'ig', { publishedAt: '2026-10-01T00:00:00Z' });
    for (const p of ['p1', 'p3']) { snap(p, '2026-11-03', 1); snap(p, '2026-11-04', 11); }
    const r = await getSocialStats(['alice'], { ...Q, accounts: ['ig', 'yt-bob'] });
    expect(r.accounts.map((a) => a.id)).toEqual(['ig']);
    expect(r.buckets.find((b) => b.start === '2026-11-04')!.byAccount).toEqual({ ig: 10 });
  });

  test("never leaks another owner's accounts or posts", async () => {
    addPost('pb', 'yt-bob', { owner: 'bob', publishedAt: '2026-10-01T00:00:00Z' });
    snap('pb', '2026-11-03', 1);
    snap('pb', '2026-11-04', 999);
    const r = await getSocialStats(['alice'], Q);
    expect(r.accounts.map((a) => a.id).sort()).toEqual(['ig', 'yt']);
    expect(JSON.stringify(r)).not.toContain('yt-bob');
    expect(r.trackingSince).toBeNull();
    expect((await getSocialStats(['alice', 'bob'], Q)).trackingSince).toBe('2026-11-03');
  });

  test('response shape: account metadata with lane, trackingSince = earliest snapshot', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-10-30', 1);
    snap('p1', '2026-11-04', 2);
    const r = await getSocialStats(['alice'], Q);
    expect(r).toMatchObject({ mode: 'gained', bucket: 'day', trackingSince: '2026-10-30' });
    expect(r.accounts.find((a) => a.id === 'yt')).toEqual({ id: 'yt', provider: 'youtube', profile: 'yt_handle', name: 'yt name', lane: 'spoon' });
    expect(r.accounts.find((a) => a.id === 'ig')!.lane).toBeNull();
  });

  test('snapshots where the platform reported no views are skipped, not read as 0', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-11-02', 100);
    snap('p1', '2026-11-03', null);
    snap('p1', '2026-11-04', 130);
    const s = await series();
    expect([s['2026-11-03']!.yt, s['2026-11-04']!.yt]).toEqual([0, 30]);
  });
});

describe('posted', () => {
  test('sums current views by publish day and account, published posts only', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-11-03T01:00:00Z', views: 100 });
    addPost('p2', 'yt', { publishedAt: '2026-11-03T22:00:00Z', views: 50 });
    addPost('p3', 'ig', { publishedAt: '2026-11-05T10:00:00Z', views: 7 });
    addPost('p4', 'yt', { publishedAt: '2026-11-05T10:00:00Z', views: 999, state: 'ERROR' });
    addPost('p5', 'yt', { publishedAt: '2026-10-20T10:00:00Z', views: 999 }); // before the range
    addPost('p6', 'yt', { owner: 'bob', publishedAt: '2026-11-03T10:00:00Z', views: 999 });
    const s = await series({ mode: 'posted' });
    expect(s['2026-11-03']).toEqual({ yt: 150, ig: 0 });
    expect(s['2026-11-05']).toEqual({ yt: 0, ig: 7 });
    expect((await series({ mode: 'posted', bucket: 'week', from: '2026-11-02', to: '2026-11-08' }))['2026-11-02']).toEqual({ yt: 150, ig: 7 });
  });
});

describe('write path', () => {
  const metrics = (views: number) => ({ views, likes: 1, comments: 2, shares: 3, saves: 4, reposts: null, quotes: null, reach: 5, clicks: null });

  test('saveMetrics upserts one snapshot per post per UTC day', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-11-03T10:00:00Z' });
    const t1 = epoch('2026-11-03T10:30:00Z');
    await saveMetrics([{ id: 'p1', metrics: metrics(10), nextAt: null }], t1);
    await saveMetrics([{ id: 'p1', metrics: metrics(40), nextAt: null }], t1 + 3600);
    await saveMetrics([{ id: 'p1', metrics: metrics(90), nextAt: null }], t1 + 86_400);
    const rows = db.query('SELECT day, views, likes, saves, reach, synced_at FROM social_post_metrics_daily ORDER BY day').all();
    expect(rows).toEqual([
      { day: '2026-11-03', views: 40, likes: 1, saves: 4, reach: 5, synced_at: t1 + 3600 },
      { day: '2026-11-04', views: 90, likes: 1, saves: 4, reach: 5, synced_at: t1 + 86_400 },
    ]);
  });

  test('a failed sync writes no snapshot', async () => {
    addPost('p1', 'yt', { publishedAt: '2026-11-03T10:00:00Z' });
    await saveMetrics([{ id: 'p1', error: 'boom', nextAt: 1 }], epoch('2026-11-03T11:00:00Z'));
    expect(db.query('SELECT COUNT(*) AS n FROM social_post_metrics_daily').get()).toEqual({ n: 0 });
  });

  test('migration seeds one baseline row per synced post', () => {
    const fresh = new Database(':memory:');
    for (const f of ['0005_social_scheduler.sql', '0025_social_lanes.sql', '0026_social_post_metrics.sql', '0027_social_post_more_metrics.sql', '0030_social_post_retention.sql']) {
      fresh.exec(readFileSync(new URL(`../../prisma/d1-migrations/${f}`, import.meta.url), 'utf8'));
    }
    fresh.run(`INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, attempts, created_at, updated_at, views, likes, metrics_synced_at)
               VALUES ('a', 'g', 'o', 'i', 'youtube', 'PUBLISHED', 0, 'x', 0, 0, 0, 77, 3, ${epoch('2026-11-02T23:59:59Z')}),
                      ('b', 'g', 'o', 'i', 'youtube', 'PUBLISHED', 0, 'x', 0, 0, 0, NULL, NULL, NULL)`);
    fresh.exec(readFileSync(new URL('../../prisma/d1-migrations/0031_social_post_metrics_daily.sql', import.meta.url), 'utf8'));
    expect(fresh.query('SELECT post_id, day, views, likes FROM social_post_metrics_daily').all()).toEqual([{ post_id: 'a', day: '2026-11-02', views: 77, likes: 3 }]);
    fresh.close();
  });
});

describe('carryForwardMetrics', () => {
  const NOW = Date.parse('2026-11-10T03:00:00Z');
  const days = (post: string) => (db.query('SELECT day, views FROM social_post_metrics_daily WHERE post_id = ? ORDER BY day').all(post) as Array<{ day: string; views: number }>);

  test("copies a published post's latest snapshot to yesterday, once", async () => {
    addPost('p1', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('p1', '2026-11-07', 100);
    snap('p1', '2026-11-08', 120);
    expect(await carryForwardMetrics(NOW)).toEqual({ carried: 1 });
    expect(days('p1').at(-1)).toEqual({ day: '2026-11-09', views: 120 });
    expect(await carryForwardMetrics(NOW)).toEqual({ carried: 0 });
    expect(days('p1')).toHaveLength(3);
  });

  test('skips posts already synced yesterday or today, and unpublished posts', async () => {
    addPost('has-yday', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('has-yday', '2026-11-09', 5);
    addPost('has-today', 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
    snap('has-today', '2026-11-10', 5);
    addPost('errored', 'yt', { state: 'ERROR' });
    snap('errored', '2026-11-05', 5);
    expect(await carryForwardMetrics(NOW)).toEqual({ carried: 0 });
  });

  test('is bounded per tick; the next run takes the rest', async () => {
    for (let i = 0; i < 5; i++) {
      addPost(`p${i}`, 'yt', { publishedAt: '2026-10-01T00:00:00Z' });
      snap(`p${i}`, '2026-11-05', i);
    }
    expect(await carryForwardMetrics(NOW, 3)).toEqual({ carried: 3 });
    expect(await carryForwardMetrics(NOW, 3)).toEqual({ carried: 2 });
    expect(await carryForwardMetrics(NOW, 3)).toEqual({ carried: 0 });
  });
});

describe('GET /api/social/stats auth', () => {
  test('401 without a bearer token or with an invalid one', async () => {
    expect((await GET(new Request('https://x.test/api/social/stats'))).status).toBe(401);
    const res = await GET(new Request('https://x.test/api/social/stats', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
  });
});
