import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { canonicalString, hmacSign } from '../queue/auth.js';
import { coverTargets, coverUrlOf, MAX_COVER_BYTES, uploadCovers, type CoverDeps } from './tools-covers.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const item = (id: string, cover: unknown) => ({ id, video: { cover } });

describe('coverUrlOf / coverTargets', () => {
  test('accepts only https TikTok image CDN hosts', () => {
    expect(coverUrlOf(item('1', 'https://p16-sign-va.tiktokcdn.com/a.jpeg?x=1'))).toBe('https://p16-sign-va.tiktokcdn.com/a.jpeg?x=1');
    expect(coverUrlOf(item('1', 'https://p19-common-sign.tiktokcdn-us.com/a.webp'))).not.toBeNull();
    expect(coverUrlOf(item('1', 'http://p16.tiktokcdn.com/a.jpeg'))).toBeNull();
    expect(coverUrlOf(item('1', 'https://evil.example/a.jpeg'))).toBeNull();
    expect(coverUrlOf(item('1', 'https://tiktokcdn.com.evil.example/a.jpeg'))).toBeNull();
    expect(coverUrlOf({ id: '1', video: { cover: '', originCover: 'https://p16.tiktokcdn.com/o.jpeg' } })).toBe('https://p16.tiktokcdn.com/o.jpeg');
  });

  test('keeps outlier order, caps at 6, skips posts without a cover', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(String(10 + i), i === 2 ? '' : `https://p16.tiktokcdn.com/${i}.jpeg`));
    const ids = ['18', '12', '10', '11', '13', '14', '15', '16', '17'];
    expect(coverTargets(items, ids).map((t) => t.id)).toEqual(['18', '10', '11', '13', '14']);
  });
});

describe('uploadCovers', () => {
  const SECRET = 'cb-secret';
  function deps(over: Partial<CoverDeps> & { cdn?: (url: string) => Response } = {}) {
    const pushes: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = String(init.body);
        pushes.push({ url: input, headers: init.headers as Record<string, string>, body });
        const stored = (JSON.parse(body).covers as Array<{ id: string }>).map((c) => c.id);
        return new Response(JSON.stringify({ handle: 'creator', stored }), { status: 200 });
      }
      return over.cdn ? over.cdn(input) : new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const d: CoverDeps = { fetch: fetchImpl, siteUrl: 'https://slashloop.dev/', secret: SECRET, nowSeconds: () => 1000, nonce: () => 'nonce-abcdefgh', ...over };
    return { d, pushes };
  }

  test('downloads covers and pushes one signed request; returns the stored ids', async () => {
    const { d, pushes } = deps();
    const stored = await uploadCovers('creator', [{ id: '1', url: 'https://p16.tiktokcdn.com/1.jpeg' }, { id: '2', url: 'https://p16.tiktokcdn.com/2.jpeg' }], d);
    expect(stored).toEqual(['1', '2']);
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(push.url).toBe('https://slashloop.dev/tools/api/internal/covers');
    const body = JSON.parse(push.body);
    expect(body.handle).toBe('creator');
    expect(body.covers[0]).toEqual({ id: '1', contentType: 'image/jpeg', data: JPEG.toString('base64') });
    const expected = hmacSign(SECRET, canonicalString('POST', '/tools/api/internal/covers', '1000', 'nonce-abcdefgh', push.body));
    expect(Object.values(push.headers)).toContain(expected);
  });

  test('drops non-images, oversized and failed downloads; pushes nothing when none are left', async () => {
    const big = Buffer.alloc(MAX_COVER_BYTES + 1, 1);
    const { d, pushes } = deps({
      cdn: (url) =>
        url.endsWith('html') ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
        : url.endsWith('big') ? new Response(big, { headers: { 'content-type': 'image/jpeg' } })
        : new Response('', { status: 403 }),
    });
    const targets = ['html', 'big', 'gone'].map((k, i) => ({ id: String(i), url: `https://p16.tiktokcdn.com/${k}` }));
    expect(await uploadCovers('creator', targets, d)).toEqual([]);
    expect(pushes).toHaveLength(0);
  });

  test('a failed push returns [] instead of throwing', async () => {
    const d: CoverDeps = {
      fetch: (async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') throw new Error('site down');
        return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
      }) as unknown as typeof fetch,
      siteUrl: 'https://slashloop.dev', secret: SECRET, nowSeconds: () => 1, nonce: () => 'n-12345678',
    };
    expect(await uploadCovers('creator', [{ id: '1', url: 'https://p16.tiktokcdn.com/1.jpeg' }], d)).toEqual([]);
  });

  test('does nothing without a secret or targets', async () => {
    const { d, pushes } = deps({ secret: '' });
    expect(await uploadCovers('creator', [{ id: '1', url: 'https://p16.tiktokcdn.com/1.jpeg' }], d)).toEqual([]);
    expect(await uploadCovers('creator', [], deps().d)).toEqual([]);
    expect(pushes).toHaveLength(0);
  });
});
