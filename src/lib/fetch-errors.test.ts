// Unit tests for fetch-error classification (src/lib/fetch-errors.ts). Pure.
import { describe, expect, test } from 'bun:test';
import { classifyFetchError } from './fetch-errors.js';

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

  test('no CDN URL -> video_unavailable', () => {
    expect(classifyFetchError('No video CDN URL in Apify response (video may be deleted, restricted, or download failed)')?.code).toBe('video_unavailable');
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
});
