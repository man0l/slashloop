import { describe, expect, test } from 'bun:test';
import {
  streamConfig, streamCopyFromUrl, streamVideoStatus,
  fetchStreamThumbnail, deleteStreamVideo,
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
    const uid = await streamCopyFromUrl(streamConfig(ENV)!, 'https://r2.signed/video.mp4', async (url, init) => {
      seen = { url: String(url), method: init?.method, body: String(init?.body) };
      return jsonRes({ success: true, result: { uid: 'uid-9' } });
    });
    expect(uid).toBe('uid-9');
    expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/stream/copy');
    expect(seen!.method).toBe('POST');
    expect(JSON.parse(seen!.body!).url).toBe('https://r2.signed/video.mp4');
  });

  test('throws the API error message on failure', async () => {
    await streamCopyFromUrl(streamConfig(ENV)!, 'https://x', async () =>
      jsonRes({ success: false, errors: [{ message: 'quota exceeded' }] }, 403),
    ).then(
      () => { throw new Error('should have thrown'); },
      (err: Error) => expect(err.message).toContain('quota exceeded'),
    );
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
