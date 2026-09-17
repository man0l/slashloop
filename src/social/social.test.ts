// Unit tests for the social scheduler library (pure parts): OAuth state
// signing, shared fetch guards, provider validity/chunking rules, error
// classification. The engine's orchestration runs against live D1 only.

import { describe, expect, test } from 'bun:test';
import { signOAuthState, verifyOAuthState } from './oauth-state.js';
import { assertPublicHttpUrl, extractMessage } from './fetch.js';
import { BadBodyError, classifyHttpError } from './errors.js';
import { TikTokProvider } from './providers/tiktok.js';
import { YouTubeProvider } from './providers/youtube.js';
import { InstagramProvider } from './providers/instagram.js';
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
    expect(provider.classify('{"error":{"code":10,"message":"Permission denied"}}', 400)).toBe('bad-body');
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
