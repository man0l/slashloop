// Unit tests for fetch-error classification (src/lib/fetch-errors.ts). Pure.
import { describe, expect, test } from 'bun:test';
import { canonicalErrorCode, classifyFetchError, LEGACY_ERROR_CODE_ALIASES } from './fetch-errors.js';

describe('classifyFetchError', () => {
  test('null/empty -> null', () => {
    expect(classifyFetchError(null)).toBeNull();
    expect(classifyFetchError('')).toBeNull();
  });

  test('spend cap message -> apify_spend_cap', () => {
    const info = classifyFetchError('Apify spend cap exceeded: monthly spend is $5.00 (cap: $5.00). Refusing to add $0.01 more. Operations are halted. Raise APIFY_SPEND_CAP_CENTS in .env to continue, or wait for the next calendar month.');
    expect(info?.code).toBe('apify_spend_cap');
  });

  test('missing key -> apify_no_key', () => {
    expect(classifyFetchError('APIFY_API_KEY is not set. Add it to .env.')?.code).toBe('apify_no_key');
  });

  test('no items -> video_not_found', () => {
    expect(classifyFetchError('Apify returned no items for video URL: https://tiktok.com/@x/v/1')?.code).toBe('video_not_found');
  });

  test('watch-page miss -> video_not_found', () => {
    expect(classifyFetchError('TikTok watch page had no playable video (http=200, rehydrate=false) — the post may be deleted, private, or region-blocked')?.code).toBe('video_not_found');
  });

  test('no CDN URL -> video_unavailable', () => {
    expect(classifyFetchError('No video CDN URL in Apify response (video may be deleted, restricted, or download failed)')?.code).toBe('video_unavailable');
  });

  test('photo slideshow -> video_unavailable with a clear message', () => {
    const info = classifyFetchError('TikTok post is a photo/slideshow (no MP4) — cannot fetch a video file');
    expect(info?.code).toBe('video_unavailable');
    expect(info?.message.toLowerCase()).toContain('slideshow');
  });

  test('CDN download failed -> apify_cdn_failed', () => {
    expect(classifyFetchError('TikTok CDN download failed (403): nope')?.code).toBe('apify_cdn_failed');
  });

  test('actor failed -> apify_actor_error', () => {
    expect(classifyFetchError('Apify actor clockworks~tiktok-scraper failed (500): boom')?.code).toBe('apify_actor_error');
  });

  test('too small -> download_failed', () => {
    expect(classifyFetchError('Downloaded file too small (300 bytes) — likely an error page')?.code).toBe('download_failed');
  });

  test('unknown message -> other, preserves a snippet', () => {
    const info = classifyFetchError('something unexpected happened');
    expect(info?.code).toBe('other');
    expect(info?.message).toContain('something unexpected happened');
  });

  test('spend cap is matched before the generic Apify actor string', () => {
    expect(classifyFetchError('Apify spend cap exceeded: ... raise APIFY_SPEND_CAP_CENTS')?.code).toBe('apify_spend_cap');
  });

  test('OpenRouter video balance-402 -> openrouter_balance', () => {
    const info = classifyFetchError('OpenRouter API error 402: {"error":{"message":"This request requires at least $1.00 in balance for video","code":402}}');
    expect(info?.code).toBe('openrouter_balance');
    expect(info?.message.toLowerCase()).toContain('top up');
  });

  test('actor-did-not-store message -> apify_not_stored (TikTok CDN refusal)', () => {
    const info = classifyFetchError('Actor did not store the video (only a TikTok CDN URL available — cannot download from a server IP); falling back to text analysis');
    expect(info?.code).toBe('apify_not_stored');
    expect(info?.message.toLowerCase()).toContain('text fallback');
  });
});

describe('provider-neutral codes for the proxy worker', () => {
  test('proxy traffic cap -> scraper_spend_cap', () => {
    const info = classifyFetchError('Proxy traffic cap exceeded: 1.000GB of 1.000GB used this month. Refusing an estimated 12.00MB more. Raise PROXY_TRAFFIC_CAP_GB in .env, or wait for the next calendar month.');
    expect(info?.code).toBe('scraper_spend_cap');
    expect(info?.message).toContain('PROXY_TRAFFIC_CAP_GB');
  });

  test('missing proxy URL -> scraper_not_configured', () => {
    expect(classifyFetchError('SCRAPER_PROXY_URL is not set. Add it to .env as user:pass@host:port')?.code).toBe('scraper_not_configured');
  });

  test('CDN refusal via proxy -> scraper_cdn_failed', () => {
    expect(classifyFetchError('TikTok CDN download failed (403) via proxy: nope')?.code).toBe('scraper_cdn_failed');
  });

  test('video over the proxy ceiling -> video_too_large (both variants)', () => {
    expect(classifyFetchError('Video is 20.00MB, above the 12.00MB SCRAPER_PROXY_MAX_VIDEO_MB ceiling — refusing to spend the traffic')?.code).toBe('video_too_large');
    expect(classifyFetchError('Video exceeded the 12.00MB SCRAPER_PROXY_MAX_VIDEO_MB ceiling — download stopped')?.code).toBe('video_too_large');
  });

  test('the Apify strings are untouched by the new rules', () => {
    expect(classifyFetchError('Apify spend cap exceeded: monthly spend is $5.00')?.code).toBe('apify_spend_cap');
    expect(classifyFetchError('APIFY_API_KEY is not set. Add it to .env.')?.code).toBe('apify_no_key');
    expect(classifyFetchError('TikTok CDN download failed (403): nope')?.code).toBe('apify_cdn_failed');
    expect(classifyFetchError('Actor did not store the video (only a TikTok CDN URL available)')?.code).toBe('apify_not_stored');
    expect(classifyFetchError('Apify actor clockworks~tiktok-scraper failed (500): boom')?.code).toBe('apify_actor_error');
  });
});

describe('LEGACY_ERROR_CODE_ALIASES', () => {
  test('every stored apify_* fetch code and both HTTP bodies map to a neutral name', () => {
    for (const old of [
      'apify_spend_cap', 'apify_no_key', 'apify_cdn_failed', 'apify_not_stored', 'apify_actor_error',
      'apify_spend_cap_breached', 'apify_spend_cap_exceeded',
    ]) {
      const neutral = canonicalErrorCode(old);
      expect(neutral).not.toBe(old);
      expect(neutral.startsWith('apify_')).toBe(false);
    }
    expect(Object.keys(LEGACY_ERROR_CODE_ALIASES)).toHaveLength(7);
  });

  test('neutral and unknown codes pass through unchanged', () => {
    expect(canonicalErrorCode('scraper_spend_cap')).toBe('scraper_spend_cap');
    expect(canonicalErrorCode('video_not_found')).toBe('video_not_found');
    expect(canonicalErrorCode('something_else')).toBe('something_else');
  });

  test('the alias for the cap codes agrees with what the classifier emits for proxy', () => {
    expect(canonicalErrorCode('apify_spend_cap')).toBe('scraper_spend_cap');
    expect(canonicalErrorCode('apify_no_key')).toBe('scraper_not_configured');
    expect(canonicalErrorCode('apify_cdn_failed')).toBe('scraper_cdn_failed');
  });
});
