import { describe, expect, test } from 'bun:test';
import {
  streamConfig, streamCopyFromUrl, streamVideoStatus,
  fetchStreamThumbnail, deleteStreamVideo, listStreamVideos,
  orphanedStreamVideos, STREAM_RECREATE_NAME_PREFIX,
} from './stream-frames.js';

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_API_TOKEN: 'tok-1' };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('streamConfig', () => {
  test('prefers the dedicated Stream token and requires an account', () => {
    expect(streamConfig(ENV)).toEqual({ accountId: 'acct-1', token: 'tok-1' });
    expect(streamConfig({ ...ENV, CLOUDFLARE_STREAM_TOKEN: 'stream-tok' })!.token).toBe('stream-tok');
    expect(streamConfig({ CLOUDFLARE_ACCOUNT_ID: 'acct-1' })).toBeNull();
    expect(streamConfig({ CLOUDFLARE_API_TOKEN: 'tok' })).toBeNull();
  });
});

describe('streamCopyFromUrl', () => {
  test('POSTs the signed URL to /stream/copy and returns the uid', async () => {
    let seen: { url: string; method?: string; body?: string } | null = null;
    const uid = await streamCopyFromUrl(streamConfig(ENV)!, 'https://r2.signed/video.mp4', {}, async (url, init) => {
      seen = { url: String(url), method: init?.method, body: String(init?.body) };
      return jsonRes({ success: true, result: { uid: 'uid-9' } });
    });
    expect(uid).toBe('uid-9');
    expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/stream/copy');
    expect(seen!.method).toBe('POST');
    const body = JSON.parse(seen!.body!);
    expect(body.url).toBe('https://r2.signed/video.mp4');
    // bounded ingest — a runaway signed URL must not ingest something huge
    expect(body.maxDurationSec).toBe(600);
  });

  test('tags the copy so the retention sweep can find orphans', async () => {
    let body: Record<string, unknown> = {};
    await streamCopyFromUrl(streamConfig(ENV)!, 'https://r2.signed/video.mp4', { name: `${STREAM_RECREATE_NAME_PREFIX}v-1` }, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonRes({ success: true, result: { uid: 'uid-9' } });
    });
    expect(body.meta).toEqual({ name: 'slashloop-recreate:v-1' });
  });

  test('throws the API error message on failure', async () => {
    await streamCopyFromUrl(streamConfig(ENV)!, 'https://x', {}, async () =>
      jsonRes({ success: false, errors: [{ message: 'quota exceeded' }] }, 403),
    ).then(
      () => { throw new Error('should have thrown'); },
      (err: Error) => expect(err.message).toContain('quota exceeded'),
    );
  });
});

describe('orphanedStreamVideos', () => {
  test('deletes only tagged slashloop recreations past the age limit', () => {
    const now = Date.parse('2026-09-12T20:00:00Z');
    const videos = [
      { uid: 'old-tagged', created: '2026-09-12T06:00:00Z', name: 'slashloop-recreate:v-1' },   // 14h old → orphan
      { uid: 'fresh-tagged', created: '2026-09-12T19:00:00Z', name: 'slashloop-recreate:v-2' }, // 1h old → keep
      { uid: 'untagged', created: '2026-09-01T00:00:00Z' },                                     // no tag → never ours
      { uid: 'no-date', created: null, name: 'slashloop-recreate:v-3' },                        // unusable → skip
    ];
    const orphans = orphanedStreamVideos(videos as never[], now, 12 * 60 * 60 * 1000);
    expect(orphans.map(o => o.uid)).toEqual(['old-tagged']);
  });

  test('listStreamVideos maps uid/created/meta rows', async () => {
    const listed = await listStreamVideos(streamConfig(ENV)!, {}, async (url) => {
      expect(String(url)).toContain('/stream?per_page=100&page=1');
      return jsonRes({ success: true, result: [{ uid: 'u1', created: '2026-09-12T10:00:00Z', meta: { name: 'slashloop-recreate:v-1' } }] });
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('slashloop-recreate:v-1');
  });
});

describe('streamVideoStatus', () => {
  test('maps readyToStream + status.state + thumbnail', async () => {
    const status = await streamVideoStatus(streamConfig(ENV)!, 'uid-9', async () =>
      jsonRes({
        success: true,
        result: {
          readyToStream: true,
          status: { state: 'ready' },
          thumbnail: 'https://customer-abc.cloudflarestream.com/uid-9/thumbnails/thumbnail.jpg',
          duration: 13.2,
        },
      }));
    expect(status.ready).toBe(true);
    expect(status.state).toBe('ready');
    expect(status.thumbnailUrl).toContain('/uid-9/thumbnails/thumbnail.jpg');
    expect(status.durationSec).toBe(13.2);
  });
});

describe('fetchStreamThumbnail', () => {
  test('appends time (seconds) and height to the thumbnail URL', async () => {
    let seenUrl = '';
    const bytes = await fetchStreamThumbnail(
      streamConfig(ENV)!, 'uid-9', 4.5,
      'https://customer-abc.cloudflarestream.com/uid-9/thumbnails/thumbnail.jpg',
      async (url) => {
        seenUrl = String(url);
        return new Response(new Uint8Array(2048).fill(1), { status: 200 });
      },
    );
    expect(seenUrl).toBe('https://customer-abc.cloudflarestream.com/uid-9/thumbnails/thumbnail.jpg?time=4.5s&height=1080');
    expect(bytes.length).toBe(2048);
  });

  test('rejects error pages masquerading as frames', async () => {
    await fetchStreamThumbnail(streamConfig(ENV)!, 'uid-9', 1, 'https://base/thumbnail.jpg', async () =>
      new Response('<html>oops</html>', { status: 200 }),
    ).then(
      () => { throw new Error('should have thrown'); },
      (err: Error) => expect(err.message).toContain('too small'),
    );
  });
});

describe('deleteStreamVideo', () => {
  test('DELETEs the video resource', async () => {
    let method = '';
    await deleteStreamVideo(streamConfig(ENV)!, 'uid-9', async (_url, init) => {
      method = init?.method ?? '';
      return jsonRes({ success: true, result: {} });
    });
    expect(method).toBe('DELETE');
  });
});
