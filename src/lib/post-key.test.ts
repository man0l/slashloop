import { expect, test } from 'bun:test';
import { firstPerPost, postKey } from './post-key.js';

const row = (id: string, platform: string, externalId: string, score: number) => ({ id, score, video: { platform, externalId } });

test('keeps the first (best-ranked) row per platform+externalId and preserves order', () => {
  const rows = [row('a', 'tiktok', 'p1', 9), row('b', 'tiktok', 'p2', 8), row('c', 'tiktok', 'p1', 7), row('d', 'reels', 'p1', 6)];
  expect(firstPerPost(rows, r => r.video).map(r => r.id)).toEqual(['a', 'b', 'd']);
});

test('postKey separates platforms', () => {
  expect(postKey({ platform: 'tiktok', externalId: '1' })).not.toBe(postKey({ platform: 'reels', externalId: '1' }));
});
