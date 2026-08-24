// Unit tests for the Apify TikTok download flow — the analyze/fetch pipeline's
// video acquisition. Three layers:
//   1. actor selection (primaryTikTokActorId) — clockworks is the default
//   2. URL resolution (resolveVideoBinaryUrl) — prefer Apify KV-store, REFUSE
//      TikTok CDN URLs (they 403 from datacenter IPs — the bug we fixed)
//   3. downloadTikTokVideo end-to-end with a mocked fetch + stubbed spend-cap
//      (no DB, no network): success, no-items, tiktok-cdn-refusal, CDN 403,
//      too-small, and primary-actor -> clockworks fallback.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub spend-cap so downloadTikTokVideo runs without a DB — assertApifyCap /
// recordApifySpend become no-ops. Must be registered before apify.js imports it.
// Spread the real module before stubbing: mock.module is process-global, so a
// partial stub deletes exports for every other test file too.
const realSpendCap = await import('./spend-cap.js');

mock.module('./spend-cap.js', () => ({
  ...realSpendCap,
  assertApifyCap: async () => {},
  recordApifySpend: async () => {},
}));

const { downloadTikTokVideo, primaryTikTokActorId, resolveVideoBinaryUrl, isTikTokCdnUrl } = await import('./apify.js');

const REAL_FETCH = globalThis.fetch;
let fetchHandler: ((url: string, init?: RequestInit) => Response | Promise<Response>) | null = null;

beforeEach(() => {
  process.env.APIFY_API_KEY = 'apify_test_key';
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler registered for this test');
    return Promise.resolve(fetchHandler(String(url), init));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.APIFY_API_KEY;
  delete process.env.APIFY_TIKTOK_ACTOR_ID;
  fetchHandler = null;
});

function apifyItemsResponse(items: unknown[]): Response {
  return new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function binaryResponse(bytes = 2048): Response {
  return new Response(new Uint8Array(bytes).fill(7), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
}

async function runDownload(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'apify-test-'));
  const outputPath = join(dir, 'video.mp4');
  fetchHandler = handler;
  try {
    return await downloadTikTokVideo({
      workspaceId: 'ws-test',
      videoUrl: 'https://www.tiktok.com/@some-creator/video/1234567890',
      outputPath,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('primaryTikTokActorId', () => {
  test('defaults to the production-proven clockworks actor', () => {
    delete process.env.APIFY_TIKTOK_ACTOR_ID;
    expect(primaryTikTokActorId()).toBe('clockworks~tiktok-scraper');
  });

  test('returns the configured custom actor when set', () => {
    process.env.APIFY_TIKTOK_ACTOR_ID = 'someone~my-fork';
    expect(primaryTikTokActorId()).toBe('someone~my-fork');
  });
});

describe('resolveVideoBinaryUrl', () => {
  test('prefers the Apify KV-store URL from mediaUrls[0]', () => {
    const r = resolveVideoBinaryUrl({ mediaUrls: ['https://kv.test/media/abc.mp4'], videoMeta: { playAddr: ['https://v16.tiktokcdn.com/x.mp4'] } });
    expect(r).toEqual({ url: 'https://kv.test/media/abc.mp4', source: 'kv_store' });
  });

  test('refuses a TikTok CDN URL even when the actor puts it in mediaUrls[0]', () => {
    const url = 'https://v16-webapp-prime.us.tiktok.com/video/abc';
    const r = resolveVideoBinaryUrl({ mediaUrls: [url], videoMeta: {} });
    expect(r).toEqual({ url, source: 'tiktok_cdn' });
    expect(isTikTokCdnUrl(url)).toBe(true);
  });

  test('matches regional image CDNs (tiktokcdn-us.com) that 403 in the browser', () => {
    const url = 'https://p19-common-sign.tiktokcdn-us.com/tos-useast8-p-0068-tx2/x~tplv-tiktokx-origin.image';
    expect(isTikTokCdnUrl(url)).toBe(true);
    expect(resolveVideoBinaryUrl({ mediaUrls: [url], videoMeta: {} })?.source).toBe('tiktok_cdn');
  });

  test('refuses a TikTok CDN URL even when the actor puts it in downloadAddr', () => {
    const url = 'https://v19.tiktokcdn.com/video/abc';
    const r = resolveVideoBinaryUrl({ videoMeta: { downloadAddr: url } });
    expect(r?.source).toBe('tiktok_cdn');
  });

  test('does not refuse a real Apify KV-store downloadAddr', () => {
    const r = resolveVideoBinaryUrl({ videoMeta: { downloadAddr: 'https://kv.rd.apify.net/v2/abc' } });
    expect(r).toEqual({ url: 'https://kv.rd.apify.net/v2/abc', source: 'kv_store' });
  });

  test('falls back to videoMeta.downloadAddr (also KV store)', () => {
    const r = resolveVideoBinaryUrl({ videoMeta: { downloadAddr: 'https://kv.test/media/abc.mp4' } });
    expect(r).toEqual({ url: 'https://kv.test/media/abc.mp4', source: 'kv_store' });
  });

  test('refuses a TikTok CDN playAddr (array form) — the 403 bug', () => {
    const r = resolveVideoBinaryUrl({ videoMeta: { playAddr: ['https://v16-webapp-prime.us.tiktok.com/video/abc'] } });
    expect(r).toEqual({ url: 'https://v16-webapp-prime.us.tiktok.com/video/abc', source: 'tiktok_cdn' });
  });

  test('refuses a TikTok CDN videoMeta.playAddr (string form)', () => {
    const r = resolveVideoBinaryUrl({ videoMeta: { playAddr: 'https://v16.tiktokcdn.com/video/abc' } });
    expect(r?.source).toBe('tiktok_cdn');
  });

  test('refuses raw.videoUrl when nothing else is present', () => {
    const r = resolveVideoBinaryUrl({ videoUrl: 'https://v16.tiktokcdn.com/video/abc' });
    expect(r?.source).toBe('tiktok_cdn');
  });

  test('returns null when there is no binary URL at all', () => {
    expect(resolveVideoBinaryUrl({ videoMeta: { coverUrl: 'https://x/cover.jpg' } })).toBeNull();
  });
});

describe('downloadTikTokVideo (mocked fetch + no DB)', () => {
  test('downloads from the Apify KV-store URL and returns sizeBytes', async () => {
    const result = await runDownload((url) =>
      url.includes('run-sync-get-dataset-items')
        ? apifyItemsResponse([{ mediaUrls: ['https://kv.test/media/video.mp4'], videoMeta: {} }])
        : binaryResponse(2048),
    );
    expect(result.sizeBytes).toBe(2048);
    expect(result.cdnUrl).toBe('https://kv.test/media/video.mp4');
    expect(result.costCents).toBeGreaterThan(0);
  });

  test('throws when the actor returns no items', async () => {
    await expect(
      runDownload((url) => (url.includes('run-sync-get-dataset-items') ? apifyItemsResponse([]) : binaryResponse())),
    ).rejects.toThrow(/Apify returned no items/);
  });

  test('refuses a TikTok-CDN-only response WITHOUT hitting the CDN (the 403 fix)', async () => {
    let cdnFetchAttempted = false;
    await expect(
      runDownload((url) => {
        if (url.includes('run-sync-get-dataset-items')) {
          return apifyItemsResponse([{ videoMeta: { playAddr: ['https://v16-webapp-prime.us.tiktok.com/video/abc'] } }]);
        }
        cdnFetchAttempted = true;
        return binaryResponse();
      }),
    ).rejects.toThrow(/did not store the video|only a TikTok CDN URL/);
    expect(cdnFetchAttempted).toBe(false); // we never try to GET the blocked CDN
  });

  test('surfaces a CDN/KV-store HTTP error as "TikTok CDN download failed"', async () => {
    await expect(
      runDownload((url) => {
        if (url.includes('run-sync-get-dataset-items')) {
          return apifyItemsResponse([{ mediaUrls: ['https://kv.test/media/video.mp4'], videoMeta: {} }]);
        }
        return new Response('<TITLE>Access Denied</TITLE>', { status: 403 });
      }),
    ).rejects.toThrow(/TikTok CDN download failed \(403\)/);
  });

  test('rejects a result that is too small to be a real video', async () => {
    await expect(
      runDownload((url) => {
        if (url.includes('run-sync-get-dataset-items')) {
          return apifyItemsResponse([{ mediaUrls: ['https://kv.test/media/video.mp4'], videoMeta: {} }]);
        }
        return binaryResponse(512); // under the 1024-byte floor
      }),
    ).rejects.toThrow(/Downloaded file too small/);
  });

  test('falls back to clockworks when the configured custom actor fails (500)', async () => {
    process.env.APIFY_TIKTOK_ACTOR_ID = 'someone~my-fork';
    const result = await runDownload((url) => {
      if (url.includes('someone~my-fork')) return new Response('actor exploded', { status: 500 });
      if (url.includes('clockworks~tiktok-scraper')) {
        return apifyItemsResponse([{ mediaUrls: ['https://kv.test/media/video.mp4'], videoMeta: {} }]);
      }
      return binaryResponse(2048);
    });
    expect(result.sizeBytes).toBe(2048);
    expect(result.cdnUrl).toBe('https://kv.test/media/video.mp4');
  });
});