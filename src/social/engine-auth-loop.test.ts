import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setActiveClient } from '../store.js';
import { socialEngineTick } from './engine.js';
import { RefreshTokenError } from './errors.js';
import { PinterestProvider } from './providers/pinterest.js';

const NOW = 1_800_000_000;
let db: Database;

function post(id: string): { state: string; attempts: number; error: string | null; pending_data: string | null } {
  return db.query('SELECT state, attempts, error, pending_data FROM social_posts WHERE id = ?').get(id) as never;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.run(`CREATE TABLE social_integrations (id TEXT PRIMARY KEY, owner_id TEXT, provider TEXT, internal_id TEXT, profile TEXT, name TEXT, picture TEXT,
    token TEXT, refresh_token TEXT, token_expires_at INTEGER, refresh_needed INTEGER, disabled INTEGER, error TEXT, tags TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE social_posts (id TEXT PRIMARY KEY, group_id TEXT, owner_id TEXT, integration_id TEXT, provider TEXT, state TEXT, publish_date INTEGER,
    content TEXT, settings TEXT, media TEXT, pending_data TEXT, release_id TEXT, release_url TEXT, error TEXT, attempts INTEGER, created_at INTEGER, updated_at INTEGER)`);
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, token, refresh_token, token_expires_at, refresh_needed, disabled, created_at, updated_at)
     VALUES ('i1', 'o', 'pinterest', 'p', 't', 'r', ${NOW + 86_400}, 0, 0, 0, 0)`,
  );
  setActiveClient({} as never, async (statements) =>
    statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]),
  );
});
afterEach(() => db.close());

describe('auth-rejected in-flight post', () => {
  test('a platform that keeps answering 401 to a fresh token ends in ERROR instead of looping in PROCESSING', async () => {
    db.run(
      `INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, settings, media, pending_data, attempts, created_at, updated_at)
       VALUES ('p1', 'g', 'o', 'i1', 'pinterest', 'PROCESSING', ${NOW - 60}, 'x', '{"boardId":"b"}', '[]', '{"mediaId":"m"}', 2, 0, 0)`,
    );
    const status = spyOn(PinterestProvider.prototype, 'checkPostStatus').mockRejectedValue(new RefreshTokenError(undefined, 'HTTP 401 {"code":2}'));
    const refresh = spyOn(PinterestProvider.prototype, 'refreshToken').mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'r',
      expiresIn: 3600,
      internalId: 'p',
      name: 'n',
      profile: 'p',
    } as never);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let tick = 0; tick < 7; tick++) await socialEngineTick({}, { nowSeconds: NOW, maxAttempts: 8 });
      const pending = post('p1');
      expect(pending.state).toBe('ERROR');
      expect(pending.error).toContain('Pinterest kept rejecting the request as unauthorized');
      expect(refresh.mock.calls.length).toBeGreaterThan(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('HTTP 401'))).toBe(true);
      expect(status).toHaveBeenCalled();
    } finally {
      status.mockRestore();
      refresh.mockRestore();
      warn.mockRestore();
    }
  });

  test('a single 401 followed by a good retry still publishes', async () => {
    db.run(
      `INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, settings, media, pending_data, attempts, created_at, updated_at)
       VALUES ('p2', 'g', 'o', 'i1', 'pinterest', 'PROCESSING', ${NOW - 60}, 'x', '{"boardId":"b"}', '[]', '{"mediaId":"m"}', 2, 0, 0)`,
    );
    const status = spyOn(PinterestProvider.prototype, 'checkPostStatus')
      .mockRejectedValueOnce(new RefreshTokenError())
      .mockResolvedValue({ status: 'completed', postId: '99', releaseUrl: 'https://www.pinterest.com/pin/99/' } as never);
    const refresh = spyOn(PinterestProvider.prototype, 'refreshToken').mockResolvedValue({ accessToken: 'new', expiresIn: 3600, internalId: 'p', name: 'n', profile: 'p' } as never);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await socialEngineTick({}, { nowSeconds: NOW });
      expect(post('p2').state).toBe('PROCESSING');
      expect(post('p2').attempts).toBe(3);
      await socialEngineTick({}, { nowSeconds: NOW });
      expect(post('p2').state).toBe('PUBLISHED');
    } finally {
      status.mockRestore();
      refresh.mockRestore();
      warn.mockRestore();
    }
  });
});
