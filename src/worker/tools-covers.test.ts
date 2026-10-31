import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { canonicalString, hmacSign } from '../queue/auth.js';
import { coverTargets, coverUrlOf, MAX_COVER_BYTES, uploadCovers, uploadTrendCovers, type CoverDeps } from './tools-covers.js';

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

describe('uploadCovers diagnostics', () => {
  function capture() {
    const lines: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    return { lines, restore: () => { console.log = log; console.warn = warn; } };
  }
  const base = { siteUrl: 'https://slashloop.dev', secret: 'cb-secret', nowSeconds: () => 1000, nonce: () => 'nonce-abcdefgh' };
  const SIGNED = 'https://p16.tiktokcdn.com/ok.jpeg?x-signature=SECRETSIG';

  test('logs per-post rejection reasons and the push result, never URLs or signatures', async () => {
    const cap = capture();
    try {
      const d: CoverDeps = {
        ...base,
        fetch: (async (input: string, init?: RequestInit) => {
          if (init?.method === 'POST') return new Response(JSON.stringify({ stored: ['1'] }), { status: 200 });
          if (input.includes('ok.jpeg')) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
          if (input.includes('heic')) return new Response('x', { headers: { 'content-type': 'image/heic' } });
          return new Response('', { status: 403 });
        }) as unknown as typeof fetch,
      };
      await uploadCovers('creator', [
        { id: '1', url: SIGNED },
        { id: '2', url: 'https://p16.tiktokcdn.com/a.heic?sig=SECRETSIG' },
        { id: '3', url: 'https://p16.tiktokcdn.com/b.jpeg?sig=SECRETSIG' },
      ], d);
      const out = cap.lines.join('\n');
      expect(out).toContain('covers for @creator: targets=3 downloaded=1 rejected=2:type_image/heic,3:http_403');
      expect(out).toContain('cover push for @creator -> 200 sent=1 stored=1');
      expect(out).not.toContain('SECRETSIG');
      expect(out).not.toContain('tiktokcdn');
    } finally { cap.restore(); }
  });

  test('flags a successful push that stores nothing, and a push failure status', async () => {
    const cap = capture();
    try {
      const mk = (res: () => Response): CoverDeps => ({
        ...base,
        fetch: (async (_u: string, init?: RequestInit) => (init?.method === 'POST' ? res() : new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }))) as unknown as typeof fetch,
      });
      const t = [{ id: '1', url: SIGNED }];
      expect(await uploadCovers('c', t, mk(() => new Response('{}', { status: 200 })))).toEqual([]);
      expect(await uploadCovers('c', t, mk(() => new Response('{"stored":[]}', { status: 200 })))).toEqual([]);
      expect(await uploadCovers('c', t, mk(() => new Response('no', { status: 401 })))).toEqual([]);
      const out = cap.lines.join('\n');
      expect(out).toContain('stored=0 stored_missing');
      expect(out).toContain('stored=0 stored_empty');
      expect(out).toContain('cover push for @c -> 401 sent=1');
    } finally { cap.restore(); }
  });

  test('says so when the callback secret is missing', async () => {
    const cap = capture();
    try {
      const d: CoverDeps = { ...base, secret: '', fetch: (async () => new Response('')) as unknown as typeof fetch };
      await uploadCovers('c', [{ id: '1', url: SIGNED }], d);
      expect(cap.lines.join('\n')).toContain('covers for @c skipped: no callback secret');
    } finally { cap.restore(); }
  });
});

describe('uploadTrendCovers', () => {
  function setup(failBatch?: number) {
    const pushes: Array<{ body: any }> = [];
    const d: CoverDeps = {
      fetch: (async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          pushes.push({ body });
          if (failBatch === pushes.length) return new Response('x', { status: 500 });
          return new Response(JSON.stringify({ stored: body.covers.map((c: { id: string }) => c.id) }), { status: 200 });
        }
        return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
      }) as unknown as typeof fetch,
      siteUrl: 'https://slashloop.dev', secret: 'cb-secret', nowSeconds: () => 1000, nonce: () => 'nonce-abcdefgh',
    };
    return { d, pushes };
  }
  const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(100 + i), url: `https://p16.tiktokcdn.com/${i}.jpeg`, author: `a${i}` }));

  test('sends each cover with its own author, no top-level handle, in batches of 6', async () => {
    const { d, pushes } = setup();
    const stored = await uploadTrendCovers(targets(8), d);
    expect(stored).toHaveLength(8);
    expect(pushes.map((p) => p.body.covers.length)).toEqual([6, 2]);
    expect(pushes[0]!.body.handle).toBeUndefined();
    expect(pushes[0]!.body.covers[0]).toMatchObject({ id: '100', handle: 'a0', contentType: 'image/jpeg' });
  });

  test('a failed batch only loses itself', async () => {
    const { d } = setup(1);
    expect(await uploadTrendCovers(targets(8), d)).toEqual(['106', '107']);
  });

  test('does nothing without a secret or targets', async () => {
    const { d, pushes } = setup();
    expect(await uploadTrendCovers([], d)).toEqual([]);
    expect(await uploadTrendCovers(targets(2), { ...d, secret: '' })).toEqual([]);
    expect(pushes).toHaveLength(0);
  });
});
