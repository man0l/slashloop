import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { setActiveClient } from '../store.js';
import { metricsInterval, nextMetricsAt, socialMetricsTick } from './metrics.js';
import { groupRows } from './posting.js';
import { RefreshTokenError } from './errors.js';
import { markPublished } from './store.js';
import { YouTubeProvider } from './providers/youtube.js';
import { TikTokProvider } from './providers/tiktok.js';
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
    token TEXT, refresh_token TEXT, token_expires_at INTEGER, refresh_needed INTEGER, disabled INTEGER, error TEXT, tags TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE social_posts (id TEXT PRIMARY KEY, group_id TEXT, owner_id TEXT, integration_id TEXT, provider TEXT, state TEXT, publish_date INTEGER,
    content TEXT, settings TEXT, media TEXT, pending_data TEXT, release_id TEXT, release_url TEXT, error TEXT, attempts INTEGER, created_at INTEGER, updated_at INTEGER)`);
  // The real migration, so the test also proves the SQL applies.
  db.exec(readFileSync(new URL('../../prisma/d1-migrations/0026_social_post_metrics.sql', import.meta.url), 'utf8'));
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

describe('socialMetricsTick', () => {
  test('syncs due posts, stores counters, and reschedules on the decaying cadence', async () => {
    insertPublished('fresh', 'youtube', NOW - 2 * H, NOW - 1);
    insertPublished('mid', 'youtube', NOW - 24 * H, NOW - 1);
    insertPublished('old', 'youtube', NOW - 10 * 24 * H, NOW - 1);
    insertPublished('later', 'youtube', NOW - H, NOW + 300);
    const fetchMetrics = spyOn(YouTubeProvider.prototype, 'fetchMetrics').mockResolvedValue({ views: 1234, likes: 56, comments: 7 });
    try {
      const report = await socialMetricsTick({}, { nowSeconds: NOW, limit: 10 });
      expect(report).toEqual({ due: 3, synced: 3, failed: 0 });
      expect(row('fresh')).toMatchObject({ views: 1234, likes: 56, comments: 7, shares: null, metrics_synced_at: NOW, metrics_next_at: NOW + 600 });
      expect(row('mid').metrics_next_at).toBe(NOW + H);
      expect(row('old').metrics_next_at).toBe(NOW + 24 * H);
      expect(row('later').metrics_synced_at).toBeNull();

      const [group] = groupRows([row('fresh')]);
      expect(group.posts[0].metrics).toEqual({ views: 1234, likes: 56, comments: 7, shares: null, syncedAt: NOW });
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
      expect(report).toEqual({ due: 2, synced: 1, failed: 1 });
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
});
