import { describe, expect, test } from 'bun:test';
import {
  parseRefreshJobPayload, isSoloRefreshPayload,
} from './jobs.js';

describe('parseRefreshJobPayload', () => {
  test('empty / invalid payloads are ordinary batched refreshes', () => {
    expect(parseRefreshJobPayload(undefined)).toEqual({});
    expect(parseRefreshJobPayload(null)).toEqual({});
    expect(parseRefreshJobPayload('')).toEqual({});
    expect(parseRefreshJobPayload('not-json')).toEqual({});
    expect(isSoloRefreshPayload(parseRefreshJobPayload('{"limitOverride":20}'))).toBe(false);
  });

  test('creator override is a solo scoring scrape', () => {
    const p = parseRefreshJobPayload(JSON.stringify({
      limitOverride: 5,
      sourceTypeOverride: 'creator',
      queryOverride: 'juanpage02',
    }));
    expect(p.limitOverride).toBe(5);
    expect(p.sourceTypeOverride).toBe('creator');
    expect(p.queryOverride).toBe('juanpage02');
    expect(isSoloRefreshPayload(p)).toBe(true);
  });

  test('queryOverride alone is also solo (do not batch a different query)', () => {
    expect(isSoloRefreshPayload({ queryOverride: 'someone' })).toBe(true);
    expect(isSoloRefreshPayload({ sourceTypeOverride: 'creator' })).toBe(true);
  });
});
