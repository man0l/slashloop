import { describe, expect, test } from 'bun:test';
import { DIGEST_CURSOR_PREFIX, clampCursorIndex, digestCursorKey } from './kv.js';

describe('digestCursorKey', () => {
  test('labels the Monday (UTC) of the week containing the date', () => {
    // Wednesday.
    expect(digestCursorKey(new Date('2026-09-09T12:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-09-07`);
    // Monday itself stays itself.
    expect(digestCursorKey(new Date('2026-09-07T00:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-09-07`);
    // Sunday belongs to the previous week.
    expect(digestCursorKey(new Date('2026-09-06T23:59:59Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-08-31`);
    expect(digestCursorKey(new Date('2026-09-06T00:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-08-31`);
  });

  test('month boundaries roll back correctly', () => {
    expect(digestCursorKey(new Date('2026-09-02T12:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-08-31`);
    expect(digestCursorKey(new Date('2026-07-01T12:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-06-29`);
    expect(digestCursorKey(new Date('2026-03-01T12:00:00Z'))).toBe(`${DIGEST_CURSOR_PREFIX}2026-02-23`);
  });
});

describe('clampCursorIndex', () => {
  test('restarts at 0 on garbage, negatives, and past-the-end indexes', () => {
    expect(clampCursorIndex(null, 10)).toBe(0);
    expect(clampCursorIndex('', 10)).toBe(0);
    expect(clampCursorIndex('-3', 10)).toBe(0);
    expect(clampCursorIndex('abc', 10)).toBe(0);
    expect(clampCursorIndex('3.5', 10)).toBe(0);
    // The sweep wrapped or the due list shrank.
    expect(clampCursorIndex('10', 10)).toBe(0);
    expect(clampCursorIndex('11', 10)).toBe(0);
  });

  test('keeps valid in-range indexes', () => {
    expect(clampCursorIndex('0', 10)).toBe(0);
    expect(clampCursorIndex('9', 10)).toBe(9);
    // The due list shrank under a previously valid cursor.
    expect(clampCursorIndex('5', 1)).toBe(0);
  });
});