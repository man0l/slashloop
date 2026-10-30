// Unit tests for the social scheduler library (pure parts): OAuth state
// signing, shared fetch guards, provider validity/chunking rules, error
// classification. The engine's orchestration runs against live D1 only.

import { describe, expect, test } from 'bun:test';
import { signOAuthState, verifyOAuthState } from './oauth-state.js';
import { assertPublicHttpUrl, extractMessage } from './fetch.js';
import { BadBodyError, classifyHttpError, connectFailureReason } from './errors.js';
import { TikTokProvider } from './providers/tiktok.js';
import { YouTubeProvider } from './providers/youtube.js';
import { InstagramProvider } from './providers/instagram.js';
import { ThreadsProvider } from './providers/threads.js';
import { PinterestProvider } from './providers/pinterest.js';
import { mediaWithScrubbedUrl, nextScrubItem } from './scrub.js';

// ── OAuth state (HMAC, stateless) ───────────────────────────────────────────

describe('oauth-state', () => {
  const secret = 'test-secret-key';

  test('round-trips a signed state', async () => {
    const state = await signOAuthState(secret, 'user-123', 1_000_000);
    const payload = await verifyOAuthState(secret, state, 1_000_060);
    expect(payload?.sub).toBe('user-123');
    expect(payload?.exp).toBe(1_000_000 + 600);
  });

  test('rejects a tampered payload', async () => {
    const state = await signOAuthState(secret, 'user-123');
    const [body, signature] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', exp: 9e9 })).toString('base64url');
    expect(await verifyOAuthState(secret, `${forged}.${signature}`)).toBeNull();
    expect(await verifyOAuthState(secret, `${body}.${Buffer.from('evil').toString('base64url')}`)).toBeNull();
  });

  test('rejects expired and malformed states', async () => {
    const state = await signOAuthState(secret, 'user-123', 1_000_000);
    expect(await verifyOAuthState(secret, state, 1_000_601)).toBeNull(); // exp + 600 passed
    expect(await verifyOAuthState(secret, 'not-a-state')).toBeNull();
    expect(await verifyOAuthState('other-secret', state)).toBeNull();
  });
});

// ── shared fetch guards ─────────────────────────────────────────────────────

describe('fetch guards', () => {
  test('assertPublicHttpUrl accepts public URLs and blocks private ones', () => {
    expect(assertPublicHttpUrl('https://media.slashloop.dev/clip.mp4')).toBeTruthy();
    expect(() => assertPublicHttpUrl('ftp://media/clip.mp4')).toThrow(BadBodyError);
    expect(() => assertPublicHttpUrl('http://localhost/clip.mp4')).toThrow(BadBodyError);
    expect(() => assertPublicHttpUrl('http://192.168.1.10/clip.mp4')).toThrow(BadBodyError);
    expect(() => assertPublicHttpUrl('not a url')).toThrow(BadBodyError);
  });

  test('classifyHttpError maps status codes to the engine triad', () => {
    expect(classifyHttpError(429, '{}')).toBe('retry');
    expect(classifyHttpError(500, '{}')).toBe('retry');
    expect(classifyHttpError(401, '{}')).toBe('refresh-token');
    expect(classifyHttpError(403, '{}')).toBe('bad-body');
    expect(classifyHttpError(400, '{}')).toBeUndefined();
  });

  test('extractMessage reads the three platform error shapes', () => {
    expect(extractMessage('{"error":{"message":"Meta says no"}}')).toBe('Meta says no');
    expect(extractMessage('{"error_description":"Google says no"}')).toBe('Google says no');
    expect(extractMessage('{"message":"TikTok says no"}')).toBe('TikTok says no');
    expect(extractMessage('plain text body')).toBe('plain text body');
  });
});

// ── TikTok ──────────────────────────────────────────────────────────────────

describe('tiktok provider', () => {
  const provider = new TikTokProvider();

  test('chunkPlan: single chunk up to 64MB, 10MB chunks beyond', () => {
    expect(provider.chunkPlan(10 * 1024 * 1024)).toEqual({ chunkSize: 10 * 1024 * 1024, totalChunkCount: 1 });
    expect(provider.chunkPlan(64 * 1024 * 1024)).toEqual({ chunkSize: 64 * 1024 * 1024, totalChunkCount: 1 });
    const plan = provider.chunkPlan(105 * 1024 * 1024);
    expect(plan).toEqual({ chunkSize: 10 * 1024 * 1024, totalChunkCount: 10 });
  });

  test('checkValidity enforces one video or photos-only', () => {
    const video = { type: 'video' as const, url: 'https://x/clip.mp4' };
    const photo = { type: 'image' as const, url: 'https://x/pic.jpg' };
    expect(provider.checkValidity({ message: '', settings: {}, media: [video] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [photo, photo] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [video, photo] })).not.toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [] })).not.toBe(true);
  });

  test('classify maps the documented error taxonomy', () => {
    expect(provider.classify('{"error":"access_token_invalid"}', 401)).toBe('refresh-token');
    expect(provider.classify('{"error":"reached_active_user_cap"}', 200)).toBe('reconnect');
    expect(provider.classify('{"error":"rate_limit_exceeded"}', 429)).toBe('retry');
    expect(provider.classify('{"error":"spam_risk_text"}', 400)).toBe('bad-body');
    expect(provider.classify('{"error":"unaudited_client_can_only_post_to_private_accounts"}', 403)).toBe('bad-body');
  });
});

// ── YouTube ─────────────────────────────────────────────────────────────────

describe('youtube provider', () => {
  const provider = new YouTubeProvider();

  test('chunk size is 256KB-aligned (Google requirement)', () => {
    expect(YouTubeProvider.CHUNK_SIZE % (256 * 1024)).toBe(0);
  });

  test('checkValidity enforces exactly one video', () => {
    const video = { type: 'video' as const, url: 'https://x/clip.mp4' };
    const photo = { type: 'image' as const, url: 'https://x/pic.jpg' };
    expect(provider.checkValidity({ message: '', settings: {}, media: [video] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [photo] })).not.toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [video, video] })).not.toBe(true);
  });

  test('classify flags expired Google grants and daily upload limits', () => {
    expect(provider.classify('{"error":"invalid_grant"}', 400)).toBe('refresh-token');
    expect(provider.classify('{"error":{"message":"uploadLimitExceeded"}}', 403)).toBe('bad-body');
    expect(provider.classify('{}', 500)).toBe('retry');
  });
});

// ── Instagram ───────────────────────────────────────────────────────────────

describe('instagram provider', () => {
  const provider = new InstagramProvider();

  test('checkValidity enforces 1..10 media items', () => {
    const photo = { type: 'image' as const, url: 'https://x/pic.jpg' };
    expect(provider.checkValidity({ message: '', settings: {}, media: [photo] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: Array(10).fill(photo) })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: Array(11).fill(photo) })).not.toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [] })).not.toBe(true);
  });

  test('classify maps Meta error codes', () => {
    expect(provider.classify('{"error":{"code":190,"message":"Session expired"}}', 400)).toBe('refresh-token');
    expect(provider.classify('{"error":{"code":4,"message":"Application request limit reached"}}', 400)).toBe('retry');
    expect(provider.classify('{"error":{"code":10,"message":"Permission revoked"}}', 400)).toBe('reconnect');
    // api.instagram.com (token endpoint) error shape
    expect(provider.classify('{"error_type":"OAuthException","code":400,"error_message":"Invalid token"}', 400)).toBe('refresh-token');
    expect(provider.classify('{}', 500)).toBe('retry');
  });

  test('generateAuthUrl uses Instagram Login (instagram.com), not Facebook Login', async () => {
    // The Meta app is a Business-type app: facebook.com/dialog/oauth without a
    // config_id returns "Feature unavailable". Instagram Login sidesteps that
    // and needs no Facebook Page.
    const url = await provider.generateAuthUrl(
      { instagram: { clientId: 'IG_APP_ID', clientSecret: 'CS' } },
      'https://mcp.slashloop.dev/api/social/callback/instagram',
      'ST',
    );
    expect(url.startsWith('https://www.instagram.com/oauth/authorize?')).toBe(true);
    expect(url).not.toContain('facebook.com');
    expect(url).toContain('client_id=IG_APP_ID');
    expect(url).toContain('scope=instagram_business_basic%2Cinstagram_business_content_publish');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=ST');
  });

  test('authenticate names the failing step and keeps the raw Meta error for logs', async () => {
    const realFetch = globalThis.fetch;
    const metaError = '{"error":{"message":"Unsupported request - method type: get","type":"IGApiException","code":100,"fbtrace_id":"T"}}';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://api.instagram.com/')) return new Response('{"access_token":"SHORT","user_id":1}', { status: 200 });
      return new Response(metaError, { status: 400 });
    }) as typeof fetch;
    try {
      const err = await provider
        .authenticate({ instagram: { clientId: 'IG_APP_ID', clientSecret: 'CS' } }, 'CODE', 'https://x/cb')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadBodyError);
      expect(err.message).toBe('long-lived token exchange: Unsupported request - method type: get');
      expect(err.detail).toBe(`HTTP 400 ${metaError}`);
      expect(connectFailureReason(err)).toBe('no_role');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('connectFailureReason maps connect failures to fixed reason codes', () => {
    expect(connectFailureReason(new BadBodyError('code exchange: Invalid platform app', 'HTTP 400 {}'))).toBe('app_config');
    expect(connectFailureReason(new BadBodyError('profile lookup: Unsupported request - method type: get'))).toBe('no_role');
    expect(connectFailureReason(new BadBodyError('profile lookup: x', 'HTTP 400 {"error":{"code":100}}'))).toBe('no_role');
    expect(connectFailureReason(new BadBodyError('profile lookup: x', 'HTTP 400 {"error":{"code":1001}}'))).toBeUndefined();
    expect(connectFailureReason(new Error('network down'))).toBeUndefined();
    expect(connectFailureReason('nope')).toBeUndefined();
  });

  test('generateAuthUrl fails loudly when the Instagram app is not configured', async () => {
    await expect(provider.generateAuthUrl({}, 'https://x/cb', 'ST')).rejects.toThrow(/not configured/);
  });
});

// ── Threads ───────────────────────────────────────────────────────────────────

describe('threads provider', () => {
  const provider = new ThreadsProvider();

  test('checkValidity enforces text-or-media, 500 chars, max 20 items', () => {
    const photo = { type: 'image' as const, url: 'https://x/pic.jpg' };
    expect(provider.checkValidity({ message: 'hello', settings: {}, media: [] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [photo] })).toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: [] })).not.toBe(true);
    expect(provider.checkValidity({ message: 'x'.repeat(501), settings: {}, media: [] })).not.toBe(true);
    expect(provider.checkValidity({ message: '', settings: {}, media: Array(21).fill(photo) })).not.toBe(true);
  });

  test('classify maps Threads/Meta error codes', () => {
    expect(provider.classify('{"error":{"code":190,"message":"Session expired"}}', 400)).toBe('refresh-token');
    expect(provider.classify('{"error":{"code":4,"message":"Application request limit reached"}}', 429)).toBe('retry');
    expect(provider.classify('{"error":{"code":10,"message":"Permission revoked"}}', 400)).toBe('reconnect');
    expect(provider.classify('{}', 500)).toBe('retry');
  });

  test('generateAuthUrl points at threads.com with the right scopes', async () => {
    const url = await provider.generateAuthUrl(
      { threads: { clientId: 'CID', clientSecret: 'CS' } },
      'https://mcp.slashloop.dev/api/social/callback/threads',
      'ST',
    );
    expect(url.startsWith('https://www.threads.com/oauth/authorize?')).toBe(true);
    expect(url).toContain('scope=threads_basic%2Cthreads_content_publish');
  });
});

// ── Pinterest ───────────────────────────────────────────────────────────────

describe('pinterest provider', () => {
  const provider = new PinterestProvider();
  const photo = { type: 'image' as const, url: 'https://x/pic.jpg' };
  const video = { type: 'video' as const, url: 'https://x/clip.mp4', thumbnail: 'https://x/cover.jpg' };

  test('checkValidity requires a board, 1 video or 1..5 images, title/description limits', () => {
    expect(provider.checkValidity({ message: 'hi', settings: {}, media: [photo] })).toMatch(/board/i);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: [] })).not.toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: [photo] })).toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: Array(5).fill(photo) })).toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: Array(6).fill(photo) })).not.toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: [video] })).toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1' }, media: [video, photo] })).not.toBe(true);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1', title: 'x'.repeat(101) }, media: [photo] })).toMatch(/title/i);
    expect(provider.checkValidity({ message: 'x'.repeat(801), settings: { boardId: 'b1' }, media: [photo] })).toMatch(/description/i);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1', link: 'not a url' }, media: [photo] })).toMatch(/link/i);
    expect(provider.checkValidity({ message: 'hi', settings: { boardId: 'b1', link: 'https://slashloop.dev' }, media: [photo] })).toBe(true);
  });

  test('classify maps Pinterest v5 error codes and statuses', () => {
    expect(provider.classify('{"code":2,"message":"Authentication failed."}', 401)).toBe('refresh-token');
    expect(provider.classify('{"code":3,"message":"Authorization failed."}', 403)).toBe('reconnect');
    expect(provider.classify('{"code":29,"message":"Too many requests"}', 429)).toBe('retry');
    expect(provider.classify('{"code":1,"message":"Invalid parameter"}', 400)).toBe('bad-body');
    expect(provider.classify('{}', 500)).toBe('retry');
  });

  test('generateAuthUrl points at pinterest.com/oauth with the write scopes', async () => {
    const url = await provider.generateAuthUrl(
      { pinterest: { clientId: '1631671', clientSecret: 'CS' } },
      'https://mcp.slashloop.dev/api/social/callback/pinterest',
      'ST',
    );
    expect(url.startsWith('https://www.pinterest.com/oauth/?')).toBe(true);
    expect(url).toContain('client_id=1631671');
    expect(url).toContain('scope=boards%3Aread%2Cpins%3Aread%2Cpins%3Awrite%2Cuser_accounts%3Aread');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=ST');
  });

  test('generateAuthUrl fails loudly when the Pinterest app is not configured', async () => {
    await expect(provider.generateAuthUrl({}, 'https://x/cb', 'ST')).rejects.toThrow(/not configured/);
  });

  test('image pins are created in postPending and report ready immediately', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: '987' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const ctx = {
        token: 'tok',
        post: { id: 'p1', message: 'desc', settings: { boardId: 'b1', title: 'T', link: 'https://slashloop.dev' }, media: [photo] },
        integration: { internalId: 'u1', profile: 'manol' },
      };
      const pending = await provider.postPending(ctx);
      expect(pending.pendingData.pinId).toBe('987');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.pinterest.com/v5/pins');
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.board_id).toBe('b1');
      expect(body.title).toBe('T');
      expect(body.link).toBe('https://slashloop.dev');
      expect(body.media_source).toEqual({ source_type: 'image_url', url: photo.url });
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');

      const status = await provider.checkPostStatus({ ...ctx, pendingData: pending.pendingData });
      expect(status.status).toBe('ready');
      const done = await provider.finalizePost({ ...ctx, pendingData: pending.pendingData });
      expect(done).toEqual({ status: 'completed', postId: '987', releaseUrl: 'https://www.pinterest.com/pin/987/' });
      expect(calls).toHaveLength(1); // finalize never re-creates an existing pin
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('video pins without a cover image are rejected before any upload', async () => {
    await expect(
      provider.postPending({
        token: 'tok',
        post: { id: 'p1', message: 'desc', settings: { boardId: 'b1' }, media: [{ type: 'video', url: 'https://x/clip.mp4' }] },
        integration: { internalId: 'u1', profile: 'manol' },
      }),
    ).rejects.toThrow(/cover image/i);
  });
});

// ── scrub helpers ───────────────────────────────────────────────────────────

describe('scrub helpers', () => {
  const media = [
    { type: 'image' as const, url: 'https://x/1.jpg' },
    { type: 'video' as const, url: 'https://x/clip.mp4', scrub: true },
    { type: 'image' as const, url: 'https://x/2.jpg', scrub: true },
  ];

  test('nextScrubItem finds the first marked item', () => {
    const next = nextScrubItem(media);
    expect(next?.index).toBe(1);
    expect(next?.item.url).toBe('https://x/clip.mp4');
    expect(nextScrubItem(media.map((m) => ({ ...m, scrub: false })))).toBeNull();
  });

  test('mediaWithScrubbedUrl swaps the url and clears only that flag', () => {
    const next = mediaWithScrubbedUrl(media, 1, 'https://x/fresh.mp4');
    expect(next[1]).toEqual({ type: 'video', url: 'https://x/fresh.mp4', scrub: false });
    expect(next[2].scrub).toBe(true); // other items untouched
    expect(next[0].url).toBe('https://x/1.jpg');
  });
});
