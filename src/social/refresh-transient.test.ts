import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setActiveClient } from '../store.js';
import { socialRefreshScan } from './engine.js';
import { BadBodyError, ReconnectError, RefreshTokenError, TransientProviderError, isAuthFailure } from './errors.js';
import { providerFetch } from './fetch.js';
import { YouTubeProvider } from './providers/youtube.js';
import { InstagramProvider } from './providers/instagram.js';

const NOW = 1_800_000_000;
const SUBREQUEST = 'Too many subrequests by single Worker invocation.';
let db: Database;

function seed(id: string, provider = 'youtube') {
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, token, refresh_token, token_expires_at, refresh_needed, disabled, error, created_at, updated_at)
     VALUES (?, 'o', ?, ?, 't', 'r', ?, 0, 0, NULL, 0, 0)`,
    [id, provider, id, NOW + 60],
  );
}

function row(id: string): { refresh_needed: number; error: string | null } {
  return db.query('SELECT refresh_needed, error FROM social_integrations WHERE id = ?').get(id) as never;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.run(`CREATE TABLE social_integrations (id TEXT PRIMARY KEY, owner_id TEXT, provider TEXT, internal_id TEXT, token TEXT, refresh_token TEXT,
    token_expires_at INTEGER, refresh_needed INTEGER, disabled INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER)`);
  setActiveClient({} as never, async (statements) =>
    statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]),
  );
});
afterEach(() => db.close());

describe('socialRefreshScan keeps accounts usable on transient failures', () => {
  test('a subrequest-limit error does not flag the account', async () => {
    seed('yt1');
    seed('yt2');
    const spy = spyOn(YouTubeProvider.prototype, 'refreshToken').mockRejectedValue(new TransientProviderError(`Network error talking to the platform: ${SUBREQUEST}`));
    try {
      const report = await socialRefreshScan({}, { nowSeconds: NOW });
      expect(row('yt1').refresh_needed).toBe(0);
      expect(row('yt2').refresh_needed).toBe(0);
      expect(row('yt1').error).toBeNull();
      expect(report.refreshed).toBe(0);
      expect(report.transient).toBe(1);
      // Past the cap every later fetch fails too — the scan stops and the next tick resumes.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a bare subrequest message (not wrapped by the fetch layer) is still transient', async () => {
    seed('yt1');
    const spy = spyOn(YouTubeProvider.prototype, 'refreshToken').mockRejectedValue(new Error(SUBREQUEST));
    try {
      await socialRefreshScan({}, { nowSeconds: NOW });
      expect(row('yt1').refresh_needed).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('provider rewrapping a transient failure as a token error does not flag the account', async () => {
    seed('ig1', 'instagram');
    const spy = spyOn(InstagramProvider.prototype, 'refreshToken').mockRejectedValue(new RefreshTokenError(SUBREQUEST));
    try {
      await socialRefreshScan({}, { nowSeconds: NOW });
      expect(row('ig1').refresh_needed).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('5xx / config errors leave the account usable', async () => {
    seed('yt1');
    const spy = spyOn(YouTubeProvider.prototype, 'refreshToken').mockRejectedValue(new BadBodyError('YouTube app is not configured'));
    try {
      const report = await socialRefreshScan({}, { nowSeconds: NOW });
      expect(row('yt1').refresh_needed).toBe(0);
      expect(report.failed).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a real auth failure (invalid_grant / 401) still flags reconnect_needed', async () => {
    seed('yt1');
    seed('yt2');
    const spy = spyOn(YouTubeProvider.prototype, 'refreshToken')
      .mockRejectedValueOnce(new RefreshTokenError())
      .mockRejectedValueOnce(new ReconnectError('Token has been expired or revoked.'));
    try {
      await socialRefreshScan({}, { nowSeconds: NOW });
      expect(row('yt1').refresh_needed).toBe(1);
      expect(row('yt2').refresh_needed).toBe(1);
      expect(row('yt2').error).toBe('Token has been expired or revoked.');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('providerFetch error typing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('network errors (incl. subrequest cap) surface as transient, not as a token error', async () => {
    globalThis.fetch = (async () => {
      throw new Error(SUBREQUEST);
    }) as unknown as typeof fetch;
    const err = await providerFetch('https://oauth2.googleapis.com/token', { sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TransientProviderError);
    expect(isAuthFailure(err)).toBe(false);
  });

  test('exhausted 5xx retries are transient', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const err = await providerFetch('https://x/api', { sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TransientProviderError);
  });

  test('401 stays an auth failure', async () => {
    globalThis.fetch = (async () => new Response('{"error":"invalid_grant"}', { status: 401 })) as unknown as typeof fetch;
    const err = await providerFetch('https://x/api', { sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(RefreshTokenError);
    expect(isAuthFailure(err)).toBe(true);
  });
});
