import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

const dbBefore = await import('../db.js');
mock.module('../db.js', () => ({
  ...dbBefore,
  db: { ...dbBefore.db, video: { update: async () => ({}) } },
}));

const { ingestThumbnails } = await import('./media.js');

const ENV = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  for (const k of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[k];
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SECRET_KEY = 'test-key';
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

const target = {
  videoId: 'v1',
  platform: 'tiktok',
  thumbnailUrl: 'https://p19-common-sign.tiktokcdn-us.com/cover.image',
};

function stubFetch(coverOk: boolean) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith('https://supabase.test')) return new Response('{}', { status: 200 });
    return coverOk
      ? new Response(new Uint8Array(1024), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      : new Response('nope', { status: 503 });
  }) as typeof fetch;
}

test('a successful cover fetch never warns', async () => {
  stubFetch(true);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const out = await ingestThumbnails('ws', [target]);
  expect(out.stored).toBe(1);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test('a failed cover fetch still warns', async () => {
  stubFetch(false);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const out = await ingestThumbnails('ws', [target]);
  expect(out.failed).toBe(1);
  expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('thumbnail ingest failed');
  warn.mockRestore();
});
