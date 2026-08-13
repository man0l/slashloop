// Unit tests for Apify spend ACCOUNTING — the two things that made the
// refresh cost-savings claim unfalsifiable:
//
//   1. cost was modelled from the REQUESTED limit, so shrinking the limit
//      lowered recorded spend whether or not Apify returned fewer results
//   2. every charge stored refId=null, so source-refresh spend and the
//      per-video MP4 downloads gemini-native pays for were one blended
//      number that could not be traced to anything
//
// Pure functions only — no DB, no network.
import { describe, expect, test } from 'bun:test';
import { apifyRunCostCents } from './apify.js';
import { decodeApifyRefId, encodeApifyRefId } from './spend-cap.js';

describe('apifyRunCostCents — bill the dataset, not the request', () => {
  test('a run that returns nothing still costs the actor start fee', () => {
    expect(apifyRunCostCents(0, false)).toBe(1);
  });

  test('cost rises with results returned', () => {
    const one = apifyRunCostCents(1, false);
    const five = apifyRunCostCents(5, false);
    const twenty = apifyRunCostCents(20, false);
    expect(one).toBeLessThan(five);
    expect(five).toBeLessThan(twenty);
  });

  test('the watermark run that returned 1 result is no longer booked as 5', () => {
    // Observed live 2026-08-12: creator:demised69 returned a single item and
    // was recorded at the 5-result estimate — a 3x overstatement.
    const actual = apifyRunCostCents(1, true);
    const requested = apifyRunCostCents(5, true);
    expect(actual).toBeLessThan(requested);
    expect(actual).toBe(1);
    expect(requested).toBe(3);
  });

  test('the date filter add-on is charged only when used', () => {
    expect(apifyRunCostCents(5, true)).toBeGreaterThan(apifyRunCostCents(5, false));
  });

  test('never negative, however odd the input', () => {
    expect(apifyRunCostCents(-10, false)).toBeGreaterThanOrEqual(0);
  });

  test('a full page still costs less than a legacy 50-video pull', () => {
    // The whole point of the incremental policy.
    expect(apifyRunCostCents(5, false)).toBeLessThan(apifyRunCostCents(50, false));
  });
});

describe('Apify spend attribution — what did this money buy?', () => {
  test('a source scrape round-trips its sourceId', () => {
    const encoded = encodeApifyRefId('source_scrape', 'src-123');
    expect(decodeApifyRefId(encoded)).toEqual({ activity: 'source_scrape', ref: 'src-123' });
  });

  test('a video download is never mistaken for refresh spend', () => {
    const encoded = encodeApifyRefId('video_download', 'https://www.tiktok.com/@a/video/1');
    const decoded = decodeApifyRefId(encoded);
    expect(decoded.activity).toBe('video_download');
    expect(decoded.ref).toBe('https://www.tiktok.com/@a/video/1');
  });

  test('a batched scrape is tagged with the canonical key it shared', () => {
    // Not the leader's sourceId: one charge, many owners.
    const encoded = encodeApifyRefId('source_scrape', 'tiktok|hashtag|ctonew');
    expect(decodeApifyRefId(encoded).ref).toBe('tiktok|hashtag|ctonew');
  });

  test('a ref containing a colon survives the round trip', () => {
    const url = 'https://www.tiktok.com/@a/video/1?x=1:2';
    expect(decodeApifyRefId(encodeApifyRefId('video_download', url)).ref).toBe(url);
  });

  test('activity survives with no ref at all', () => {
    expect(decodeApifyRefId(encodeApifyRefId('source_scrape', null)))
      .toEqual({ activity: 'source_scrape', ref: null });
  });

  test('pre-change rows report as legacy rather than guessing', () => {
    // 378 rows were written with refId=null. Attributing them to either
    // activity would silently misreport history.
    expect(decodeApifyRefId(null).activity).toBe('legacy');
    expect(decodeApifyRefId(undefined).activity).toBe('legacy');
    expect(decodeApifyRefId('some-old-freeform-value').activity).toBe('legacy');
  });
});
