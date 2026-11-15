import { describe, expect, test } from 'bun:test';
import { BadBodyError } from './errors.js';
import { YouTubeProvider } from './providers/youtube.js';

const ctx = { token: 't', releaseId: 'vid', thumbnailUrl: 'https://example.com/t.jpg' };

async function withFetch(thumbsSet: Response, run: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/thumbnails/set')) return thumbsSet;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  }) as never;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('YouTube setThumbnail', () => {
  test('a 403 permission refusal says the channel must be verified', async () => {
    const body = JSON.stringify({ error: { message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails." } });
    await withFetch(new Response(body, { status: 403 }), async () => {
      const err = await new YouTubeProvider().setThumbnail(ctx).catch((e) => e);
      expect(err).toBeInstanceOf(BadBodyError);
      expect(err.message).toContain('channel must be verified');
    });
  });

  test('other failures pass through unchanged', async () => {
    const body = JSON.stringify({ error: { message: 'Video not found' } });
    await withFetch(new Response(body, { status: 404 }), async () => {
      const err = await new YouTubeProvider().setThumbnail(ctx).catch((e) => e);
      expect(err.message).toBe('Video not found');
    });
  });
});
