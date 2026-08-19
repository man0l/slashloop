import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BYTES_PER_GB, bytesToCents, fmtBytes, meterBytes, processBytesUsed, resetProcessMeter,
  scopeBytesUsed, withMeterScope, wouldExceedCap,
} from './bandwidth.js';
import { remainingBudgetBytes, vendorRemainingBytes } from './budget.js';
import { parseProxiesResponse } from './proxy-cheap.js';
import { proxyAdapter, runTikTokProxyScrape } from './proxy-adapter.js';
import { jsonFromBody, resetImpersonatedClient } from './impersonate-http.js';
import { clearLookupCaches } from './tiktok-web.js';
import type { TikTokHttp } from './tiktok-web.js';
import {
  DEFAULT_PROVIDER,
  getScraper,
  listScrapers,
  resolveProviderName,
  scrapeCapKind,
  selectDownloadAdapter,
  ScraperUnavailableError,
} from './index.js';
import { extractHandle, extractVideoId, listPlayableVariants, pickSmallestVariant, resolvePlayableVideo } from './proxy-adapter.js';
import { extractSlideshowImages, slideshowKeysFromRaw, videoFromWatchHtml } from './tiktok-web.js';
import { slideshowPath } from '../storage.js';
import { parseProxyUrl, proxyFetch, resetDispatcher, withStickySession } from './proxy-http.js';
import {
  createTimeFromItemId,
  challengeIdFromFrontity,
  challengeItemListUrl,
  creatorItemListUrl,
  dedupeItems,
  embedPageUrl,
  estimateScrapeBytes,
  extractFrontityJson,
  extractRehydrationJson,
  identityFromUserDetail,
  itemsFromApiPayload,
  itemsFromFrontity,
  itemsFromRehydration,
  tiktokSourceUrl,
  webItemToApifyShape,
  xhrPatternFor,
} from './tiktok-web.js';
import { isWafChallenge, solveWafCookies } from './waf.js';

const ENV_KEYS = [
  'SCRAPER_PROVIDER',
  'SCRAPER_FALLBACK_PROVIDER',
  'SCRAPER_PROXY_URL',
  'APIFY_API_KEY',
  'PROXY_TRAFFIC_CAP_GB',
  'PROXY_COST_CENTS_PER_GB',
  'SCRAPER_PROXY_COUNTRY',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  resetDispatcher();
  resetProcessMeter();
  resetImpersonatedClient();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetDispatcher();
  resetProcessMeter();
  resetImpersonatedClient();
});

describe('resolveProviderName', () => {
  test('defaults to apify when unset', () => {
    expect(resolveProviderName()).toBe(DEFAULT_PROVIDER);
    expect(resolveProviderName('')).toBe('apify');
    expect(resolveProviderName('default')).toBe('apify');
  });

  test('reads SCRAPER_PROVIDER and accepts aliases', () => {
    process.env.SCRAPER_PROVIDER = 'PROXY';
    expect(resolveProviderName()).toBe('proxy');
    expect(resolveProviderName('residential')).toBe('proxy');
    expect(resolveProviderName('proxy-cheap')).toBe('proxy');
    expect(resolveProviderName('tiktok-web')).toBe('proxy');
  });

  test('unknown names stay unknown so a typo cannot silently bill Apify', () => {
    expect(resolveProviderName('clockworks')).toBe('clockworks');
    expect(() => getScraper('clockworks')).toThrow(ScraperUnavailableError);
  });

  test('scrapeCapKind follows the selected adapter', () => {
    expect(scrapeCapKind('tiktok')).toBe('apify');
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gateway.example.com:8080';
    expect(scrapeCapKind('tiktok')).toBe('proxy');
  });

  test('listScrapers includes both built-in adapters', () => {
    expect(listScrapers()).toEqual(expect.arrayContaining(['apify', 'proxy']));
  });
});

describe('selectDownloadAdapter (exclusive — no fallback)', () => {
  test('uses proxy for TikTok when SCRAPER_PROXY_URL is set, even if SCRAPER_PROVIDER=apify', () => {
    process.env.SCRAPER_PROVIDER = 'apify';
    process.env.APIFY_API_KEY = 'test-key';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gateway.example.com:8080';
    expect(selectDownloadAdapter('tiktok').name).toBe('proxy');
  });

  test('uses apify when the proxy is not configured', () => {
    process.env.SCRAPER_PROVIDER = 'apify';
    process.env.APIFY_API_KEY = 'test-key';
    expect(selectDownloadAdapter('tiktok').name).toBe('apify');
  });

  test('an explicit provider wins and does not fall back', () => {
    process.env.SCRAPER_PROXY_URL = 'user:pass@gateway.example.com:8080';
    process.env.APIFY_API_KEY = 'test-key';
    expect(selectDownloadAdapter('tiktok', 'apify').name).toBe('apify');
  });

  test('does not substitute apify when proxy is named but unconfigured', () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.APIFY_API_KEY = 'test-key';
    expect(() => selectDownloadAdapter('tiktok', 'proxy')).toThrow(ScraperUnavailableError);
    expect(() => selectDownloadAdapter('tiktok', 'proxy')).toThrow(/SCRAPER_PROXY_URL/);
  });
});

describe('parseProxyUrl', () => {
  test('accepts the bare vendor form and encodes credentials', () => {
    const cfg = parseProxyUrl('user:secret@gateway.example.com:8080');
    expect(cfg).toMatchObject({ host: 'gateway.example.com', port: 8080, username: 'user', password: 'secret_country-US' });
    expect(cfg?.url).toContain('gateway.example.com:8080');

    const encoded = parseProxyUrl('user:p%40ss%20word@gateway.example.com:8080');
    expect(encoded).toMatchObject({ host: 'gateway.example.com', password: 'p@ss word_country-US' });
    expect(encoded?.url).toContain(encodeURIComponent('p@ss word'));
  });

  test('accepts a full URL and drops a copied path', () => {
    const cfg = parseProxyUrl('http://alice:secret@proxy.example:9000/extra');
    expect(cfg).toMatchObject({ host: 'proxy.example', port: 9000, username: 'alice', password: 'secret_country-US' });
    expect(cfg?.url.endsWith(':9000')).toBe(true);
  });

  test('rejects empty or unparseable input', () => {
    expect(parseProxyUrl(undefined)).toBeNull();
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('   ')).toBeNull();
  });

  test('pins Proxy-Cheap country on the password when unset', () => {
    const pinned = parseProxyUrl('user:secret@gateway.example.com:8080');
    expect(pinned?.password).toBe('secret_country-US');
    process.env.SCRAPER_PROXY_COUNTRY = 'GB';
    expect(parseProxyUrl('user:secret@gateway.example.com:8080')?.password).toBe('secret_country-GB');
    expect(parseProxyUrl('user:secret_country-DE@gateway.example.com:8080')?.password).toBe('secret_country-DE');
    process.env.SCRAPER_PROXY_COUNTRY = '';
    expect(parseProxyUrl('user:secret@gateway.example.com:8080')?.password).toBe('secret');
  });
});

describe('tiktok-web helpers', () => {
  test('extractRehydrationJson reads a complete blob and ignores truncation', () => {
    const payload = { __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { secUid: 'SEC' } } } } };
    const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script></html>`;
    expect(extractRehydrationJson(html)?.__DEFAULT_SCOPE__['webapp.user-detail'].userInfo.user.secUid).toBe('SEC');
    expect(extractRehydrationJson(html.slice(0, 80))).toBeNull();
    expect(extractRehydrationJson('<html>no blob</html>')).toBeNull();
  });

  test('webItemToApifyShape keeps only the fields normalizeTikTok reads', () => {
    const shaped = webItemToApifyShape({
      id: '123',
      desc: 'hello',
      createTime: 1_700_000_000,
      author: { uniqueId: 'creator', nickname: 'C' },
      authorStats: { followerCount: 9 },
      stats: { playCount: 10, diggCount: 2, commentCount: 1, shareCount: 0, collectCount: 3 },
      video: { cover: 'https://cdn.example/cover.jpg', duration: 12, playAddr: 'https://cdn.example/huge.mp4' },
    });
    expect(shaped).toMatchObject({
      id: '123',
      text: 'hello',
      webVideoUrl: 'https://www.tiktok.com/@creator/video/123',
      playCount: 10,
      videoMeta: { originalCoverUrl: 'https://cdn.example/cover.jpg', duration: 12 },
    });
    expect(shaped.videoMeta.playAddr).toBeUndefined();
    expect(shaped.coverDownloadUrl).toBeUndefined();
  });

  test('estimateScrapeBytes charges a lookup only when one is needed', () => {
    expect(estimateScrapeBytes(10, false)).toBe(10 * 7 * 1024);
    expect(estimateScrapeBytes(10, true)).toBe(10 * 7 * 1024 + 360 * 1024);
  });

  test('itemsFromRehydration lifts video ItemStructs out of the blob', () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.user-detail': {
          itemList: [
            { id: '1234567', video: { cover: 'c.jpg' }, desc: 'one' },
            { id: 'nope', video: { cover: 'x' } },
          ],
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script>`;
    const items = itemsFromRehydration(html);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('1234567');
  });

  test('createTimeFromItemId reads the snowflake timestamp', () => {
    expect(createTimeFromItemId('7178571592316783915')).toBe(1_671_391_444);
    expect(createTimeFromItemId('not-an-id')).toBeNull();
  });

  test('itemsFromFrontity lifts embed playlist rows', () => {
    const payload = {
      source: {
        data: {
          '/embed/@jawhacks': {
            userInfo: { uniqueId: 'jawhacks', followerCount: 29500 },
            videoList: [
              {
                id: '7178571592316783915',
                desc: 'mewing',
                coverUrl: 'https://cdn.example/cover.jpg',
                playCount: 43_400_000,
                authorUniqueId: 'jawhacks',
              },
            ],
          },
        },
      },
    };
    const html = `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(payload)}</script>`;
    expect(extractFrontityJson(html)?.source.data['/embed/@jawhacks'].videoList).toHaveLength(1);
    const items = itemsFromFrontity(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '7178571592316783915',
      desc: 'mewing',
      createTime: 1_671_391_444,
      author: { uniqueId: 'jawhacks' },
      authorStats: { followerCount: 29500 },
      stats: { playCount: 43_400_000 },
    });
    expect(embedPageUrl('creator', '@JawHacks')).toBe('https://www.tiktok.com/embed/@JawHacks');
    expect(embedPageUrl('hashtag', '#vibecoding')).toBe('https://www.tiktok.com/embed/tag/vibecoding');
  });

  test('challengeIdFromFrontity and challengeItemListUrl are the hashtag latest path', () => {
    const html = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify({
      source: { data: { '/embed/tag/mewing': { embedInfo: { id: '1362460', videoCount: 1 }, videoList: [] } } },
    })}</script>`;
    expect(challengeIdFromFrontity(html)).toBe('1362460');
    const url = challengeItemListUrl('1362460', '0', 15);
    expect(url).toContain('/api/challenge/item_list/');
    expect(url).toContain('challengeID=1362460');
    expect(url).toContain('from_page=hashtag');
  });

  test('a 20-video item_list over 512KB still parses (do not truncate first)', () => {
    const body = JSON.stringify({
      itemList: Array.from({ length: 20 }, (_, i) => ({
        id: String(7_000_000_000_000_000_000 + i),
        desc: 'x'.repeat(28_000),
        createTime: 1_700_000_000,
      })),
    });
    expect(body.length).toBeGreaterThan(512 * 1024);
    expect(jsonFromBody(body)?.itemList).toHaveLength(20);
    expect(jsonFromBody(body.slice(0, 512 * 1024))).toBeNull();
  });

  test('creatorItemListUrl is the yt-dlp user playlist endpoint', () => {
    const url = creatorItemListUrl('SEC-JAW', '1700000000000', 15);
    expect(url).toContain('/api/creator/item_list/');
    expect(url).toContain('secUid=SEC-JAW');
    expect(url).toContain('cursor=1700000000000');
    expect(url).toContain('from_page=user');
    expect(url).toContain('type=1');
  });

  test('solveWafCookies brute-forces the yt-dlp SHA-256 puzzle', () => {
    const n = '42';
    const base = Buffer.from('challenge-base');
    const expected = createHash('sha256').update(base).update(n).digest();
    const challenge = {
      v: { a: base.toString('base64'), c: expected.toString('base64') },
    };
    const html = [
      '<html><body>Please wait...',
      `<div id="cs" class="${Buffer.from(JSON.stringify(challenge)).toString('base64')}"></div>`,
      '<div id="wci" class="_wafchallengeid"></div>',
      '</body></html>',
    ].join('');
    expect(isWafChallenge(html)).toBe(true);
    const cookies = solveWafCookies(html);
    expect(cookies[0]?.name).toBe('_wafchallengeid');
    const decoded = JSON.parse(Buffer.from(cookies[0]!.value, 'base64').toString('utf8'));
    expect(Buffer.from(decoded.d, 'base64').toString('utf8')).toBe('42');
  });

  test('identityFromUserDetail reads the warm-signer user/detail shape', () => {
    const id = identityFromUserDetail({
      userInfo: { user: { secUid: 'SEC123', uniqueId: 'JawHacks' }, stats: { followerCount: 99 } },
    }, 'fallback');
    expect(id).toEqual({ secUid: 'SEC123', handle: 'JawHacks', followers: 99 });
    expect(identityFromUserDetail({ userInfo: {} }, 'x')).toBeNull();
  });
});

describe('proxy adapter helpers', () => {
  test('extractVideoId reads watch and short URLs', () => {
    expect(extractVideoId('https://www.tiktok.com/@x/video/1234567890123456789')).toBe('1234567890123456789');
    expect(extractVideoId('https://www.tiktok.com/@x/photo/1234567890123456789')).toBe('1234567890123456789');
    expect(extractVideoId('not-a-url')).toBeNull();
  });

  test('extractHandle reads the @user from a watch URL', () => {
    expect(extractHandle('https://www.tiktok.com/@mr.paidsocial/video/7672558938923076877')).toBe('mr.paidsocial');
    expect(extractHandle('https://www.tiktok.com/video/7672558938923076877')).toBeNull();
  });

  test('videoFromWatchHtml lifts playAddr out of the rehydration blob', () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          itemInfo: { itemStruct: { video: { playAddr: 'https://cdn.example/v.mp4', bitrateInfo: [] } } },
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script>`;
    expect(videoFromWatchHtml(html)?.playAddr).toBe('https://cdn.example/v.mp4');
    expect(videoFromWatchHtml('<html>no blob</html>')).toBeNull();
  });

  test('resolvePlayableVideo uses the watch page, not /api/item/detail', async () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          itemInfo: { itemStruct: { video: { playAddr: 'https://cdn.example/v.mp4' } } },
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script>`;
    const urls: string[] = [];
    const http: TikTokHttp = {
      async getJson() { throw new Error('item/detail must not be called'); },
      async getText(url) {
        urls.push(url);
        return { json: null, status: 200, ok: true, text: html, bytes: html.length };
      },
    };
    const video = await resolvePlayableVideo(
      'https://www.tiktok.com/@mr.paidsocial/video/7672558938923076877',
      '7672558938923076877',
      http,
    );
    expect(video.playAddr).toBe('https://cdn.example/v.mp4');
    expect(urls).toEqual(['https://www.tiktok.com/@mr.paidsocial/video/7672558938923076877']);
  });

  test('resolvePlayableVideo rejects a photo/slideshow post', async () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': {
          itemInfo: {
            itemStruct: {
              imagePost: { images: [{ imageURL: { urlList: ['https://cdn.example/1.jpg'] } }] },
              video: { playAddr: '', downloadAddr: '', duration: 0 },
            },
          },
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script>`;
    const http: TikTokHttp = {
      async getJson() { return { json: null, status: 200, ok: true, text: '', bytes: 0 }; },
      async getText() {
        return { json: null, status: 200, ok: true, text: html, bytes: html.length };
      },
    };
    await expect(resolvePlayableVideo(
      'https://www.tiktok.com/@emirailab/video/7656450385845996830',
      '7656450385845996830',
      http,
    )).rejects.toMatchObject({ name: 'SlideshowPostError', images: ['https://cdn.example/1.jpg'] });
  });

  test('extractSlideshowImages walks imageURL.urlList', () => {
    expect(extractSlideshowImages({
      imagePost: {
        images: [
          { imageURL: { urlList: ['https://cdn.example/a.jpg'] } },
          { imageURL: { urlList: ['https://cdn.example/b.jpg'] } },
        ],
      },
    })).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  test('slideshowKeysFromRaw and slideshowPath are the R2 layout', () => {
    expect(slideshowPath('ws-1', 'vid-1', 3)).toBe('ws-1/vid-1/slides/03.jpg');
    expect(slideshowKeysFromRaw(JSON.stringify({
      postKind: 'slideshow',
      slideshowKeys: ['ws-1/vid-1/slides/00.jpg', 'ws-1/vid-1/slides/01.jpg'],
    }))).toEqual(['ws-1/vid-1/slides/00.jpg', 'ws-1/vid-1/slides/01.jpg']);
  });

  test('pickSmallestVariant takes the cheapest declared rung', () => {
    const pick = pickSmallestVariant({
      bitrateInfo: [
        { GearName: 'hd', PlayAddr: { UrlList: ['https://cdn.example/hd.mp4'], DataSize: 5_000_000 } },
        { GearName: 'sd', PlayAddr: { UrlList: ['https://cdn.example/sd.mp4'], DataSize: 1_200_000 } },
      ],
      playAddr: 'https://cdn.example/default.mp4',
    });
    expect(pick).toMatchObject({ url: 'https://cdn.example/sd.mp4', label: 'sd', declaredBytes: 1_200_000 });
  });

  test('pickSmallestVariant falls back to playAddr when no ladder exists', () => {
    expect(pickSmallestVariant({ playAddr: 'https://cdn.example/only.mp4' })).toMatchObject({
      url: 'https://cdn.example/only.mp4',
      label: 'playAddr',
    });
    expect(pickSmallestVariant({ playAddr: { UrlList: ['https://cdn.example/obj.mp4'] } })).toMatchObject({
      url: 'https://cdn.example/obj.mp4',
    });
    expect(pickSmallestVariant({ playAddr: '' })).toBeNull();
    expect(pickSmallestVariant({})).toBeNull();
  });

  test('listPlayableVariants is cheapest-first and de-dupes playAddr', () => {
    const urls = listPlayableVariants({
      bitrateInfo: [
        { GearName: 'hd', PlayAddr: { UrlList: ['https://cdn.example/hd.mp4'], DataSize: 5_000_000 } },
        { GearName: 'sd', PlayAddr: { UrlList: ['https://cdn.example/sd.mp4'], DataSize: 1_200_000 } },
      ],
      playAddr: 'https://cdn.example/sd.mp4',
    }).map(v => v.url);
    expect(urls).toEqual(['https://cdn.example/sd.mp4', 'https://cdn.example/hd.mp4']);
  });
});

describe('bandwidth math', () => {
  test('fmtBytes and bytesToCents never under-count a real transfer', () => {
    expect(fmtBytes(512)).toBe('512B');
    expect(fmtBytes(2048)).toBe('2.0KB');
    expect(bytesToCents(0)).toBe(0);
    expect(bytesToCents(1)).toBe(1);
    process.env.PROXY_COST_CENTS_PER_GB = '100';
    expect(bytesToCents(1024 * 1024 * 1024)).toBe(100);
  });

  test('withMeterScope keeps concurrent jobs byte-attribution separate', async () => {
    const jobA = withMeterScope(async () => {
      meterBytes(100);
      await new Promise(r => setTimeout(r, 10));
      meterBytes(50);
      return scopeBytesUsed();
    });
    const jobB = withMeterScope(async () => {
      meterBytes(30);
      await new Promise(r => setTimeout(r, 5));
      return scopeBytesUsed();
    });
    const [a, b] = await Promise.all([jobA, jobB]);
    expect(a).toBe(150);
    expect(b).toBe(30);
    expect(processBytesUsed()).toBe(0);
  });
});

describe('proxyFetch caps', () => {
  const REAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test('aborts after maxBytes and still meters the truncated body', async () => {
    globalThis.fetch = (async () => new Response('x'.repeat(10_000), {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as typeof fetch;

    const result = await proxyFetch('https://www.tiktok.com/@x', { maxBytes: 100, direct: true });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.bytes).toBeGreaterThan(0);
  });
});

describe('proxy budget (vendor + internal rail)', () => {
  test('wouldExceedCap is the rule the adapter uses to refuse a scrape', () => {
    expect(wouldExceedCap(0, 1024, 512)).toBe(false);
    expect(wouldExceedCap(600, 1024, 500)).toBe(true);
    expect(wouldExceedCap(1024, 1024, 1)).toBe(true);
    expect(wouldExceedCap(0, 0, 1)).toBe(true);
  });

  test('parseProxiesResponse reads the live GET /proxies shape', () => {
    // Payload captured from api.proxy-cheap.com/proxies on 2026-08-13.
    const parsed = parseProxiesResponse({
      proxies: [{
        id: 2302967,
        status: 'ACTIVE',
        networkType: 'RESIDENTIAL',
        bandwidth: { total: 5, used: null },
      }],
    });
    expect(parsed).toMatchObject({
      proxyId: 2302967,
      totalGb: 5,
      usedGb: null,
      remainingGb: null,
      status: 'ACTIVE',
    });
    expect(vendorRemainingBytes(parsed)).toBeNull();
  });

  test('proxyCheapBandwidth serves a cached snapshot across calls', async () => {
    const REAL_FETCH = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({
        proxies: [{ id: 1, status: 'ACTIVE', bandwidth: { total: 5, used: 4.75 } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const { proxyCheapBandwidth, resetProxyCheapCache } = await import('./proxy-cheap.js');
    process.env.PROXY_CHEAP_API_KEY = 'k';
    process.env.PROXY_CHEAP_API_SECRET = 's';
    resetProxyCheapCache();
    try {
      const first = await proxyCheapBandwidth();
      const second = await proxyCheapBandwidth();
      expect(first?.remainingGb).toBeCloseTo(0.25);
      expect(second).toEqual(first);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = REAL_FETCH;
      resetProxyCheapCache();
    }
  });

  test('remainingBudgetBytes takes the tighter of UsageLog cap and billed GB', () => {
    const vendor = parseProxiesResponse({
      proxies: [{ id: 1, status: 'ACTIVE', bandwidth: { total: 5, used: 4.75 } }],
    });
    expect(vendor?.remainingGb).toBeCloseTo(0.25);
    // Internal rail still has 1GB left; vendor only has 0.25GB — vendor wins.
    const left = remainingBudgetBytes(0, BYTES_PER_GB, vendor);
    expect(left).toBe(Math.round(0.25 * BYTES_PER_GB));
    expect(wouldExceedCap(0, left, Math.round(0.3 * BYTES_PER_GB))).toBe(true);
    expect(wouldExceedCap(0, left, 1024)).toBe(false);
  });

  test('unreported vendor used falls back to the internal PROXY_TRAFFIC_CAP_GB rail', () => {
    const vendor = parseProxiesResponse({
      proxies: [{ id: 1, status: 'ACTIVE', bandwidth: { total: 5, used: null } }],
    });
    const left = remainingBudgetBytes(512, 2048, vendor);
    expect(left).toBe(1536);
  });
});

function profilePageHtml(videos: Array<{ id: string; desc: string; views: number }>): string {
  const items = videos.map(v => ({
    id: v.id,
    desc: v.desc,
    createTime: 1_700_000_000,
    author: { uniqueId: 'jawhacks', nickname: 'Jaw' },
    authorStats: { followerCount: 12_345 },
    stats: { playCount: v.views, diggCount: 2, commentCount: 1, shareCount: 0, collectCount: 0 },
    video: { cover: 'https://cdn.example/cover.jpg', duration: 9 },
  }));
  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: { user: { secUid: 'SEC-JAW', uniqueId: 'jawhacks' }, stats: { followerCount: 12_345 } },
        itemList: items,
      },
    },
  };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

describe('browser scrape helpers', () => {
  test('tiktokSourceUrl and xhrPatternFor match the actor routes', () => {
    expect(tiktokSourceUrl('creator', '@JawHacks')).toBe('https://www.tiktok.com/@JawHacks');
    expect(tiktokSourceUrl('hashtag', '#vibecoding')).toBe('https://www.tiktok.com/tag/vibecoding');
    expect(tiktokSourceUrl('keyword', 'looksmaxxing')).toBe('https://www.tiktok.com/search?q=looksmaxxing');
    expect(xhrPatternFor('creator').test('https://www.tiktok.com/api/post/item_list/?secUid=x')).toBe(true);
    expect(xhrPatternFor('hashtag').test('https://www.tiktok.com/api/challenge/item_list/?id=1')).toBe(true);
    expect(xhrPatternFor('keyword').test('https://www.tiktok.com/api/search/item/full/?q=x')).toBe(true);
  });

  test('itemsFromApiPayload unwraps search hits and drops junk', () => {
    const items = itemsFromApiPayload({
      item_list: [
        { item: { id: '1234567', video: { cover: 'c' } } },
        { id: 'nope', video: {} },
        { id: '7654321', video: { cover: 'd' } },
      ],
    });
    expect(items.map(i => i.id)).toEqual(['1234567', '7654321']);
    expect(dedupeItems([...items, items[0]])).toHaveLength(2);
  });
});

describe('runTikTokProxyScrape (shipped creator path)', () => {
  test('turns a profile page into NormalizedVideos without launching Chrome', async () => {
    clearLookupCaches();
    const html = profilePageHtml([
      { id: '1111111111111111111', desc: 'first', views: 90_000 },
      { id: '2222222222222222222', desc: 'second', views: 40_000 },
      { id: '3333333333333333333', desc: 'third', views: 10_000 },
    ]);
    const http: TikTokHttp = {
      async getJson() {
        return { json: null, status: 200, ok: true, text: '', bytes: 0 };
      },
      async getText(url) {
        expect(url).toContain('/@jawhacks');
        expect(url.includes('/embed/')).toBe(false);
        return { json: null, status: 200, ok: true, text: html, bytes: html.length };
      },
    };

    const result = await runTikTokProxyScrape({
      workspaceId: 'ws-test',
      platform: 'tiktok',
      sourceType: 'creator',
      query: 'jawhacks',
      limit: 3,
    }, http);

    expect(result.rawCount).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items.map(v => v.externalId)).toEqual([
      '1111111111111111111',
      '2222222222222222222',
      '3333333333333333333',
    ]);
    expect(result.items[0]?.creatorHandle).toBe('jawhacks');
    expect(result.items[0]?.views).toBe(90_000);
    expect(result.notices).toEqual([]);
  });

  test('prefers the embed playlist when Frontity videoList is present', async () => {
    clearLookupCaches();
    const payload = {
      source: {
        data: {
          '/embed/@jawhacks': {
            userInfo: { uniqueId: 'jawhacks', followerCount: 12_345 },
            videoList: [
              {
                id: '7178571592316783915',
                desc: 'from embed',
                coverUrl: 'https://cdn.example/cover.jpg',
                playCount: 1_000,
                authorUniqueId: 'jawhacks',
              },
            ],
          },
        },
      },
    };
    const html = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify(payload)}</script>`;
    const http: TikTokHttp = {
      async getJson() {
        return { json: null, status: 200, ok: true, text: '', bytes: 0 };
      },
      async getText(url) {
        if (url.includes('/embed/')) {
          return { json: null, status: 200, ok: true, text: html, bytes: html.length };
        }
        return { json: null, status: 200, ok: true, text: '<html></html>', bytes: 13 };
      },
    };

    const result = await runTikTokProxyScrape({
      workspaceId: 'ws-test',
      platform: 'tiktok',
      sourceType: 'creator',
      query: 'jawhacks',
      limit: 3,
    }, http);

    expect(result.rawCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.externalId).toBe('7178571592316783915');
    expect(result.items[0]?.caption).toBe('from embed');
    expect(result.items[0]?.views).toBe(1_000);
    expect(result.items[0]?.postedAt).toBe(new Date(1_671_391_444 * 1000).toISOString());
  });

  test('proxyAdapter.scrape resumes from a persisted receipt with zero traffic', async () => {
    const receiptItem = {
      platform: 'tiktok',
      externalId: '7178571592316783915',
      url: 'https://www.tiktok.com/@jawhacks/video/7178571592316783915',
      thumbnailUrl: 'https://cdn.example/cover.jpg',
      coverDownloadUrl: null,
      creatorHandle: 'jawhacks',
      creatorFollowers: 12345,
      caption: 'from receipt',
      postedAt: new Date(1_671_391_444 * 1000).toISOString(),
      views: 100,
      likes: 2,
      comments: 1,
      shares: null,
      saves: null,
      durationSec: 9,
      transcript: null,
      transcriptSource: 'none',
      raw: {},
    };
    const REAL_FETCH = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (init?.method === 'POST' && url.includes('/object/sign/')) {
        return new Response(JSON.stringify({ signedURL: '/object/sign/media/scrape-receipts/src-1.json?token=x' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        version: 1,
        at: Date.now(),
        items: [receiptItem],
        notices: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    process.env.SCRAPER_PROXY_URL = 'user:pass@gateway.example.com:8080';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'test-key';

    try {
      const result = await proxyAdapter.scrape({
        workspaceId: 'ws-test',
        platform: 'tiktok',
        sourceType: 'creator',
        query: 'jawhacks',
        limit: 3,
        resumeDatasetId: 'scrape-receipts/src-1.json',
      });
      expect(result.resumed).toBe(true);
      expect(result.costCents).toBe(0);
      expect(result.bytesUsed).toBe(0);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.externalId).toBe('7178571592316783915');
      expect(result.items[0]?.caption).toBe('from receipt');
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
  });

  test('hashtag scrape prefers signed challenge item_list over evergreen embed', async () => {
    clearLookupCaches();
    const now = Math.floor(Date.now() / 1000);
    const embedHtml = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify({
      source: {
        data: {
          '/embed/tag/mewing': {
            embedInfo: { id: '1362460', videoCount: 9 },
            videoList: [{
              id: '7396100831218633989',
              desc: 'old viral',
              coverUrl: 'https://cdn.example/c.jpg',
              playCount: 62_000_000,
              authorUniqueId: 'old',
            }],
          },
        },
      },
    })}</script>`;
    const http: TikTokHttp = {
      async getJson(url) {
        if (url.includes('/api/challenge/item_list/')) {
          return {
            json: {
              itemList: [{
                id: '7670597177768545566',
                desc: 'fresh',
                createTime: now,
                author: { uniqueId: 'onlysonazone' },
                stats: { playCount: 1_800_000, diggCount: 10 },
                video: { cover: 'https://cdn.example/n.jpg' },
              }],
              hasMore: false,
              cursor: '1',
            },
            status: 200, ok: true, text: '{}', bytes: 20,
          };
        }
        return { json: null, status: 200, ok: true, text: '', bytes: 0 };
      },
      async getText() {
        return { json: null, status: 200, ok: true, text: embedHtml, bytes: embedHtml.length };
      },
    };
    const result = await runTikTokProxyScrape({
      workspaceId: 'ws-test',
      platform: 'tiktok',
      sourceType: 'hashtag',
      query: 'mewing',
      limit: 10,
    }, http);
    expect(result.items.some(v => v.externalId === '7670597177768545566')).toBe(true);
    expect(result.items[0]?.externalId).toBe('7670597177768545566');
  });

  test('dry limit=2 still asks the latest hashtag feed, not only embed popular', async () => {
    clearLookupCaches();
    const now = Math.floor(Date.now() / 1000);
    const embedHtml = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify({
      source: {
        data: {
          '/embed/tag/mewing': {
            embedInfo: { id: '1362460', videoCount: 9 },
            videoList: [
              {
                id: '7396100831218633989',
                desc: 'old viral a',
                coverUrl: 'https://cdn.example/c.jpg',
                playCount: 62_000_000,
                authorUniqueId: 'old',
              },
              {
                id: '7396100831218633990',
                desc: 'old viral b',
                coverUrl: 'https://cdn.example/d.jpg',
                playCount: 40_000_000,
                authorUniqueId: 'old2',
              },
            ],
          },
        },
      },
    })}</script>`;
    let itemListCalled = false;
    const http: TikTokHttp = {
      async getJson(url) {
        if (url.includes('/api/challenge/item_list/')) {
          itemListCalled = true;
          return {
            json: {
              itemList: [{
                id: '7670597177768545566',
                desc: 'fresh',
                createTime: now,
                author: { uniqueId: 'onlysonazone' },
                stats: { playCount: 1_800_000, diggCount: 10 },
                video: { cover: 'https://cdn.example/n.jpg' },
              }],
              hasMore: false,
              cursor: '1',
            },
            status: 200, ok: true, text: '{}', bytes: 20,
          };
        }
        return { json: null, status: 200, ok: true, text: '', bytes: 0 };
      },
      async getText() {
        return { json: null, status: 200, ok: true, text: embedHtml, bytes: embedHtml.length };
      },
    };
    const result = await runTikTokProxyScrape({
      workspaceId: 'ws-test',
      platform: 'tiktok',
      sourceType: 'hashtag',
      query: 'mewing',
      limit: 2,
    }, http);
    expect(itemListCalled).toBe(true);
    expect(result.items[0]?.externalId).toBe('7670597177768545566');
  });
});
