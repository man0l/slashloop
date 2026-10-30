import { describe, expect, test } from 'bun:test';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, UploadError, classifyMediaType, storeSocialMedia, storeSocialMediaFromUrl } from './media-upload.js';

const respond = (body: string | ReadableStream<Uint8Array> | null, headers: Record<string, string>, status = 200) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

async function failure(p: Promise<unknown>): Promise<UploadError> {
  try {
    await p;
  } catch (err) {
    return err as UploadError;
  }
  throw new Error('expected rejection');
}

describe('social media limits (same as api/social-upload.ts)', () => {
  test('type table and size caps', () => {
    expect(classifyMediaType('image/jpeg')).toMatchObject({ ext: '.jpg', isVideo: false, maxBytes: MAX_IMAGE_BYTES });
    expect(classifyMediaType('image/png; charset=x')).toMatchObject({ ext: '.png' });
    expect(classifyMediaType('video/mp4')).toMatchObject({ ext: '.mp4', isVideo: true, maxBytes: MAX_VIDEO_BYTES });
    expect(classifyMediaType('video/quicktime')).toMatchObject({ ext: '.mov' });
    expect(classifyMediaType('image/gif')).toBeNull();
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(95 * 1024 * 1024);
  });

  test('storeSocialMedia rejects unsupported types and empty/oversize bodies before writing', async () => {
    expect((await failure(storeSocialMedia(new Uint8Array(4), 'image/gif'))).code).toBe('unsupported_type');
    expect((await failure(storeSocialMedia(new Uint8Array(0), 'image/png'))).code).toBe('too_large');
    expect((await failure(storeSocialMedia(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png'))).code).toBe('too_large');
  });
});

describe('storeSocialMediaFromUrl guards', () => {
  test('private / non-http URLs are refused without fetching', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('x'); }) as unknown as typeof fetch;
    for (const url of ['http://localhost/a.jpg', 'http://10.0.0.5/a.jpg', 'ftp://x/a.jpg']) {
      expect((await failure(storeSocialMediaFromUrl(url, spy))).code).toBe('invalid_url');
    }
    expect(called).toBe(false);
  });

  test('HTTP errors, unsupported content types and declared oversize are rejected', async () => {
    expect((await failure(storeSocialMediaFromUrl('https://x.test/a.jpg', respond('nope', {}, 404)))).code).toBe('fetch_failed');
    expect((await failure(storeSocialMediaFromUrl('https://x.test/a', respond('x', { 'content-type': 'text/html' })))).code).toBe('unsupported_type');
    const big = respond('x', { 'content-type': 'image/jpeg', 'content-length': String(MAX_IMAGE_BYTES + 1) });
    expect((await failure(storeSocialMediaFromUrl('https://x.test/a.jpg', big))).code).toBe('too_large');
  });

  test('a streamed body over the cap is cut off even without content-length', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 25) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const err = await failure(storeSocialMediaFromUrl('https://x.test/a.jpg', respond(stream, { 'content-type': 'image/jpeg' })));
    expect(err.code).toBe('too_large');
    expect(sent).toBeLessThan(25);
  });
});
