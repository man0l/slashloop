import { describe, expect, mock, test } from 'bun:test';

mock.module('../../src/social/index.js', () => ({
  socialEngineTick: async () => ({ claimed: 1, published: 1 }),
  socialRefreshScan: async () => {
    throw new Error('D1 batch[1] timed out after 15000ms');
  },
}));
mock.module('../social.js', () => ({ socialConfigFromEnv: () => ({}) }));

describe('/api/cron/social', () => {
  test('a failing refresh scan does not fail the tick', async () => {
    process.env.CRON_SECRET = 's3cret';
    const { GET } = await import('./social.js');
    const res = await GET(new Request('https://x/api/cron/social', { headers: { authorization: 'Bearer s3cret' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: number; refresh: { error?: string; scanned: number } };
    expect(body.published).toBe(1);
    expect(body.refresh.scanned).toBe(0);
    expect(body.refresh.error).toContain('timed out');
  });
});
