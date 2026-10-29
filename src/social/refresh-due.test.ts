import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setActiveClient } from '../store.js';
import { integrationsDueForRefresh, refreshLeadSeconds } from './store.js';

const NOW = 1_800_000_000;
let db: Database;

function seed(id: string, provider: string, expiresIn: number | null, extra: { refreshNeeded?: number; disabled?: number; refreshToken?: string | null } = {}) {
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, token, refresh_token, token_expires_at, refresh_needed, disabled, created_at, updated_at)
     VALUES (?, 'o', ?, ?, 't', ?, ?, ?, ?, 0, 0)`,
    [id, provider, id, extra.refreshToken === undefined ? 'r' : extra.refreshToken, expiresIn === null ? null : NOW + expiresIn, extra.refreshNeeded ?? 0, extra.disabled ?? 0],
  );
}

async function dueIds(): Promise<string[]> {
  return (await integrationsDueForRefresh(25, NOW)).map((r) => r.id).sort();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.run(`CREATE TABLE social_integrations (id TEXT PRIMARY KEY, owner_id TEXT, provider TEXT, internal_id TEXT, token TEXT, refresh_token TEXT,
    token_expires_at INTEGER, refresh_needed INTEGER, disabled INTEGER, created_at INTEGER, updated_at INTEGER)`);
  setActiveClient({} as never, async (statements) =>
    statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]),
  );
});
afterEach(() => db.close());

describe('integrationsDueForRefresh', () => {
  test('a freshly refreshed YouTube/TikTok token is not due on the next tick', async () => {
    seed('yt', 'youtube', 3500);
    seed('tt', 'tiktok', 23 * 3600);
    expect(await dueIds()).toEqual([]);
  });

  test('short-lived tokens become due inside their lead window, or once expired', async () => {
    seed('yt-soon', 'youtube', 10 * 60);
    seed('yt-expired', 'youtube', -30);
    seed('tt-soon', 'tiktok', 30 * 60);
    seed('tt-later', 'tiktok', 2 * 3600);
    expect(await dueIds()).toEqual(['tt-soon', 'yt-expired', 'yt-soon']);
  });

  test('long-lived providers keep the 2 day lead', async () => {
    seed('ig-soon', 'instagram', 24 * 3600);
    seed('th-later', 'threads', 5 * 24 * 3600);
    expect(await dueIds()).toEqual(['ig-soon']);
  });

  test('skips unhealthy, disabled and non-refreshable rows', async () => {
    seed('a', 'youtube', 60, { refreshNeeded: 1 });
    seed('b', 'youtube', 60, { disabled: 1 });
    seed('c', 'youtube', 60, { refreshToken: null });
    seed('d', 'youtube', null);
    expect(await dueIds()).toEqual([]);
  });

  test('leads: short for youtube/tiktok, 2 days otherwise', () => {
    expect(refreshLeadSeconds('youtube')).toBeLessThan(refreshLeadSeconds('instagram'));
    expect(refreshLeadSeconds('tiktok')).toBeLessThan(24 * 3600);
    expect(refreshLeadSeconds('instagram')).toBe(2 * 24 * 3600);
  });
});
