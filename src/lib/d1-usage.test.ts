import { expect, test } from 'bun:test';
import {
  recordD1Usage,
  snapshotD1Usage,
  deltaD1Usage,
  totalD1Usage,
  formatD1Usage,
} from './d1-usage.js';

test('snapshot/delta attributes usage between two points', () => {
  const before = snapshotD1Usage();
  recordD1Usage(10, 4, 2);
  const d = deltaD1Usage(before);
  expect(d).toEqual({ reads: 10, writes: 4, queries: 2 });
  // A second delta from the same snapshot sees the same work once.
  expect(deltaD1Usage(before)).toEqual({ reads: 10, writes: 4, queries: 2 });
});

test('non-positive and non-finite inputs are ignored, never throw', () => {
  const before = snapshotD1Usage();
  recordD1Usage(0, -1, NaN);
  recordD1Usage(NaN, Infinity, 0);
  expect(deltaD1Usage(before)).toEqual({ reads: 0, writes: 0, queries: 0 });
});

test('formatD1Usage is empty when idle, compact otherwise', () => {
  expect(formatD1Usage({ reads: 0, writes: 0, queries: 0 })).toBe('');
  expect(formatD1Usage({ reads: 30, writes: 5, queries: 6 })).toBe(' d1+w5/r30/q6');
});

test('totals are monotonic', () => {
  const a = totalD1Usage();
  recordD1Usage(1, 1, 1);
  const b = totalD1Usage();
  expect(b.reads).toBeGreaterThanOrEqual(a.reads + 1);
  expect(b.writes).toBeGreaterThanOrEqual(a.writes + 1);
});
