import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { setActiveClient } from '../store.js';
import { metricsInterval, nextMetricsAt, socialMetricsTick } from './metrics.js';
import { groupRows, listCalendar } from './posting.js';
import { RefreshTokenError } from './errors.js';
import { markPublished } from './store.js';
import { YouTubeProvider } from './providers/youtube.js';
import { TikTokProvider } from './providers/tiktok.js';
import { InstagramProvider } from './providers/instagram.js';
import { PinterestProvider } from './providers/pinterest.js';
import { ThreadsProvider } from './providers/threads.js';
import type { SocialPostRow } from './types.js';

const NOW = 1_800_000_000;
const H = 3600;
let db: Database;

function row(id: string): SocialPostRow {
  return db.query('SELECT * FROM social_posts WHERE id = ?').get(id) as never;
}

function insertPublished(id: string, provider: string, publishedAt: number, nextAt: number | null) {
  db.run(
    `INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, release_id, release_url, attempts, created_at, updated_at, published_at, metrics_next_at)
     VALUES (?, 'g', 'o', ?, ?, 'PUBLISHED', ?, 'x', 'vid-' || ?, 'https://example.com', 0, 0, 0, ?, ?)`,
    [id, provider === 'youtube' ? 'yt' : 'tt', provider, publishedAt, id, publishedAt, nextAt],
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.run(`CREATE TABLE social_integrations (id TEXT PRIMARY KEY, owner_id TEXT, provider TEXT, internal_id TEXT, profile TEXT, name TEXT, picture TEXT,
    token TEXT, refresh_token TEXT, token_expires_at INTEGER, refresh_needed INTEGER, disabled INTEGER, error TEXT, tags TEXT, insights_status TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE social_posts (id TEXT PRIMARY KEY, group_id TEXT, owner_id TEXT, integration_id TEXT, provider TEXT, state TEXT, publish_date INTEGER,
    content TEXT, settings TEXT, media TEXT, pending_data TEXT, release_id TEXT, release_url TEXT, error TEXT, attempts INTEGER, created_at INTEGER, updated_at INTEGER)`);
  // The real migration, so the test also proves the SQL applies.
  db.exec(readFileSync(new URL('../../prisma/d1-migrations/0026_social_post_metrics.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../prisma/d1-migrations/0027_social_post_more_metrics.sql', import.meta.url), 'utf8'));
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, token, refresh_token, token_expires_at, refresh_needed, disabled, created_at, updated_at)
     VALUES ('yt', 'o', 'youtube', 'c', 'old', 'r', ${NOW + 3600}, 0, 0, 0, 0), ('tt', 'o', 'tiktok', 't', 'x', 'r', ${NOW + 3600}, 0, 0, 0, 0)`,
  );
  setActiveClient({} as never, async (statements) =>
    statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]),
  );
});
afterEach(() => db.close());

describe('metrics cadence', () => {
  test('10 min for the first 12h, hourly for the next 48h, then daily', () => {
    expect(metricsInterval(0)).toBe(600);
    expect(metricsInterval(12 * H - 1)).toBe(600);
    expect(metricsInterval(12 * H)).toBe(H);
    expect(metricsInterval(60 * H - 1)).toBe(H);
    expect(metricsInterval(60 * H)).toBe(24 * H);
    expect(metricsInterval(30 * 24 * H)).toBe(24 * H);
    expect(nextMetricsAt(NOW, NOW + 5 * H)).toBe(NOW + 5 * H + 600);
  });

  test('markPublished stamps published_at and schedules the first sync', async () => {
    db.run(`INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, attempts, created_at, updated_at)
            VALUES ('p', 'g', 'o', 'yt', 'youtube', 'PROCESSING', 0, 'x', 0, 0, 0)`);
    await markPublished('p', 'vid', 'https://youtu.be/vid');
    const p = row('p');
    expect(p.published_at).toBeGreaterThan(0);
    expect(p.metrics_next_at).toBe((p.published_at as number) + 600);
  });
});

describe('socialMetricsTick insights status', () => {
  test('stores the Instagram insights status on the account, only when it changes', async () => {
    db.run(`INSERT INTO social_integrations (id, owner_id, provider, internal_id, token, refresh_token, token_expires_at, refresh_needed, disabled, created_at, updated_at)
            VALUES ('ig', 'o', 'instagram', 'i', 'x', 'r', ${NOW + 3600}, 0, 0, 0, 0)`);
    db.run(`INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, release_id, release_url, attempts, created_at, updated_at, published_at, metrics_next_at)
            VALUES ('p', 'g', 'o', 'ig', 'instagram', 'PUBLISHED', ${NOW - H}, 'x', 'm1', 'https://example.com', 0, 0, 0, ${NOW - H}, ${NOW - 1})`);
    const fetchMetrics = spyOn(InstagramProvider.prototype, 'fetchMetrics').mockResolvedValue({ likes: 1, comments: 0, insightsStatus: 'missing_permission' });
    try {
      await socialMetricsTick({}, { nowSeconds: NOW, limit: 10 });
      const account = () => db.query("SELECT insights_status FROM social_integrations WHERE id = 'ig'").get() as { insights_status: string | null };
      expect(account().insights_status).toBe('missing_permission');
      expect(row('p')).toMatchObject({ likes: 1, views: null });

      fetchMetrics.mockResolvedValue({ likes: 1, comments: 0, views: 50, insightsStatus: 'ok' });
      db.run("UPDATE social_posts SET metrics_next_at = ? WHERE id = 'p'", [NOW - 1]);
      await socialMetricsTick({}, { nowSeconds: NOW + 1, limit: 10 });
      expect(account().insights_status).toBe('ok');
      expect(row('p').views).toBe(50);
    } finally {
      fetchMetrics.mockRestore();
    }
  });
});

describe('socialMetricsTick', () => {
  test('syncs due posts, stores counters, and reschedules on the decaying cadence', async () => {
    insertPublished('fresh', 'youtube', NOW - 2 * H, NOW - 1);
    insertPublished('mid', 'youtube', NOW - 24 * H, NOW - 1);
    insertPublished('old', 'youtube', NOW - 10 * 24 * H, NOW - 1);
    insertPublished('later', 'youtube', NOW - H, NOW + 300);
    const fetchMetrics = spyOn(YouTubeProvider.prototype, 'fetchMetrics').mockResolvedValue({ views: 1234, likes: 56, comments: 7 });
    try {
      const report = await socialMetricsTick({}, { nowSeconds: NOW, limit: 10 });
      expect(report).toEqual({ due: 3, synced: 3, stale: 0, failed: 0 });
      expect(row('fresh')).toMatchObject({ views: 1234, likes: 56, comments: 7, shares: null, saves: null, metrics_synced_at: NOW, metrics_next_at: NOW + 600 });
      expect(row('mid').metrics_next_at).toBe(NOW + H);
      expect(row('old').metrics_next_at).toBe(NOW + 24 * H);
      expect(row('later').metrics_synced_at).toBeNull();

      const [group] = groupRows([row('fresh')]);
      expect(group.posts[0].metrics).toEqual({ views: 1234, likes: 56, comments: 7, shares: null, saves: null, reposts: null, quotes: null, reach: null, clicks: null, syncedAt: NOW });
    } finally {
      fetchMetrics.mockRestore();
    }
  });

  test('providers without fetchMetrics are never selected', async () => {
    expect((TikTokProvider.prototype as { fetchMetrics?: unknown }).fetchMetrics).toBeUndefined();
    insertPublished('tk', 'tiktok', NOW - H, NOW - 1);
    const report = await socialMetricsTick({}, { nowSeconds: NOW });
    expect(report.due).toBe(0);
  });

  test('a 401 refreshes the token once and retries; a failure keeps old counters', async () => {
    insertPublished('a', 'youtube', NOW - H, NOW - 1);
    insertPublished('b', 'youtube', NOW - H, NOW - 2);
    db.run(`UPDATE social_posts SET views = 10, metrics_synced_at = 1 WHERE id = 'a'`);
    const fetchMetrics = spyOn(YouTubeProvider.prototype, 'fetchMetrics').mockImplementation(async (ctx) => {
      if (ctx.token === 'old') throw new RefreshTokenError();
      if (ctx.releaseId === 'vid-a') throw new Error('quota exceeded');
      return { views: 99 };
    });
    const refresh = spyOn(YouTubeProvider.prototype, 'refreshToken').mockResolvedValue({ accessToken: 'new', expiresIn: 3600 } as never);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await socialMetricsTick({}, { nowSeconds: NOW });
      expect(report).toEqual({ due: 2, synced: 1, stale: 0, failed: 1 });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(row('b').views).toBe(99);
      expect(row('a')).toMatchObject({ views: 10, metrics_error: 'quota exceeded', metrics_next_at: NOW + 600 });
      expect((db.query("SELECT token FROM social_integrations WHERE id = 'yt'").get() as { token: string }).token).toBe('new');
    } finally {
      fetchMetrics.mockRestore();
      refresh.mockRestore();
      warn.mockRestore();
    }
  });

  test('views going backwards is a stale read: last counters kept, retried on cadence (SLA-1254)', async () => {
    insertPublished('drop', 'youtube', NOW - H, NOW - 1);
    insertPublished('first', 'youtube', NOW - H, NOW - 2);
    insertPublished('grow', 'youtube', NOW - H, NOW - 3);
    db.run(`UPDATE social_posts SET views = 6, likes = 1, metrics_synced_at = 1 WHERE id IN ('drop', 'grow')`);
    const fetchMetrics = spyOn(YouTubeProvider.prototype, 'fetchMetrics').mockImplementation(async (ctx) =>
      ctx.releaseId === 'vid-grow' ? { views: 12, likes: 0, comments: 0 } : { views: 0, likes: 0, comments: 0 },
    );
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const report = await socialMetricsTick({}, { nowSeconds: NOW });
      expect(report).toEqual({ due: 3, synced: 2, stale: 1, failed: 0 });
      expect(row('drop')).toMatchObject({ views: 6, likes: 1, metrics_synced_at: 1, metrics_error: null, metrics_next_at: NOW + 600 });
      // Zero on a never-synced post is a real zero; other counters may still fall.
      expect(row('first')).toMatchObject({ views: 0, metrics_synced_at: NOW });
      expect(row('grow')).toMatchObject({ views: 12, likes: 0, metrics_synced_at: NOW });
    } finally {
      fetchMetrics.mockRestore();
      info.mockRestore();
    }
  });
});

describe('platform-specific counters', () => {
  const ctx = { token: 't', releaseId: 'r', releaseUrl: null, integration: { internalId: 'i', profile: '' } };
  const mockFetch = (route: (url: string) => unknown) =>
    spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) =>
      Response.json(route(String(input)))) as typeof fetch);

  test('Instagram: likes/comments from the media, views/reach/saves/shares from insights', async () => {
    const f = mockFetch((url) =>
      url.includes('/insights')
        ? { data: [{ name: 'views', values: [{ value: 900 }] }, { name: 'reach', values: [{ value: 700 }] }, { name: 'saved', values: [{ value: 12 }] }, { name: 'shares', values: [{ value: 4 }] }] }
        : { like_count: 30, comments_count: 5 },
    );
    try {
      expect(await new InstagramProvider().fetchMetrics(ctx)).toEqual({ likes: 30, comments: 5, views: 900, reach: 700, saves: 12, shares: 4, insightsStatus: 'ok' });
    } finally {
      f.mockRestore();
    }
  });

  test('Instagram: a refused insights call keeps likes/comments and records why', async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: { code: 10, message: '(#10) Application does not have permission for this action' } }, 'missing_permission'],
      [400, { error: { code: 100, message: 'Insights are only available for professional accounts' } }, 'personal_account'],
      [400, { error: { code: 100, message: 'Unsupported get request' } }, 'error: Unsupported get request'],
    ];
    for (const [status, body, reason] of cases) {
      const f = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) =>
        String(input).includes('/insights') ? Response.json(body, { status }) : Response.json({ like_count: 1, comments_count: 0 })) as typeof fetch);
      try {
        expect(await new InstagramProvider().fetchMetrics(ctx)).toEqual({ likes: 1, comments: 0, insightsStatus: reason });
      } finally {
        f.mockRestore();
      }
    }
  });

  test('Instagram: empty insights data is reported as no_data', async () => {
    const f = mockFetch((url) => (url.includes('/insights') ? { data: [] } : { like_count: 0, comments_count: 0 }));
    try {
      expect((await new InstagramProvider().fetchMetrics(ctx)).insightsStatus).toBe('no_data');
    } finally {
      f.mockRestore();
    }
  });

  test('Pinterest: analytics endpoint — impressions as views, saves, outbound clicks, lifetime reactions/comments (SLA-1282)', async () => {
    const urls: string[] = [];
    const f = mockFetch((url) => {
      urls.push(url);
      return {
        all: {
          summary_metrics: { IMPRESSION: 1500.0, SAVE: 40.0, OUTBOUND_CLICK: 17.0 },
          daily_metrics: [],
          lifetime_metrics: { TOTAL_REACTIONS: 8, TOTAL_COMMENTS: 2 },
        },
      };
    });
    try {
      const publishedAt = Math.floor(Date.now() / 1000) - 3 * 86400;
      expect(await new PinterestProvider().fetchMetrics({ ...ctx, publishedAt })).toEqual({ views: 1500, likes: 8, comments: 2, saves: 40, clicks: 17 });
      // Not GET /pins/{id}: that needs "pinner data" access (code 6410).
      const url = new URL(urls[0]);
      expect(url.pathname).toBe('/v5/pins/r/analytics');
      expect(url.searchParams.get('start_date')).toBe(new Date(publishedAt * 1000).toISOString().slice(0, 10));
      expect(url.searchParams.get('end_date')).toBe(new Date().toISOString().slice(0, 10));

      // Older than the 90-day window: the start clamps to 89 days back.
      urls.length = 0;
      await new PinterestProvider().fetchMetrics({ ...ctx, publishedAt: Math.floor(Date.now() / 1000) - 400 * 86400 });
      expect(new URL(urls[0]).searchParams.get('start_date')).toBe(new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10));
    } finally {
      f.mockRestore();
    }
  });

  test('Threads: replies as comments, reposts, quotes and shares kept apart', async () => {
    const rows = { views: 300, likes: 20, replies: 6, reposts: 3, quotes: 1, shares: 2 };
    const f = mockFetch(() => ({ data: Object.entries(rows).map(([name, value]) => ({ name, values: [{ value }] })) }));
    try {
      expect(await new ThreadsProvider().fetchMetrics(ctx)).toEqual({ views: 300, likes: 20, comments: 6, reposts: 3, quotes: 1, shares: 2 });
    } finally {
      f.mockRestore();
    }
  });

  test('every counter round-trips through the store and the calendar payload', async () => {
    insertPublished('pin', 'youtube', NOW - H, NOW - 1);
    const all = { views: 1, likes: 2, comments: 3, shares: 4, saves: 5, reposts: 6, quotes: 7, reach: 8, clicks: 9 };
    const fetchMetrics = spyOn(YouTubeProvider.prototype, 'fetchMetrics').mockResolvedValue(all);
    try {
      await socialMetricsTick({}, { nowSeconds: NOW });
      expect(row('pin')).toMatchObject(all);
      expect(groupRows([row('pin')])[0].posts[0].metrics).toEqual({ ...all, syncedAt: NOW });
    } finally {
      fetchMetrics.mockRestore();
    }
  });
});

describe('calendar account', () => {
  test('each post carries the account it publishes to', async () => {
    db.run("UPDATE social_integrations SET name = 'Slashloop', profile = 'slashloop', picture = 'https://cdn/p.jpg' WHERE id = 'yt'");
    insertPublished('a', 'youtube', NOW, null);
    insertPublished('b', 'tiktok', NOW, null);
    db.run("DELETE FROM social_integrations WHERE id = 'tt'");
    const { groups } = await listCalendar(['o'], NOW - 1, NOW + 1);
    const byId = Object.fromEntries(groups[0].posts.map((p) => [p.id, p.account]));
    expect(byId.a).toEqual({ id: 'yt', name: 'Slashloop', profile: 'slashloop', picture: 'https://cdn/p.jpg' });
    expect(byId.b).toEqual({ id: 'tt', name: null, profile: null, picture: null });
  });
});
