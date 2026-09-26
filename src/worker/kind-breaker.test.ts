import { expect, test } from 'bun:test';
import { createKindBreaker } from './kind-breaker.js';

test('healthy kinds pass through, failures below threshold do not park', () => {
  let t = 0;
  const b = createKindBreaker({ threshold: 3, cooldownMs: 60_000, now: () => t });
  expect(b.filterKinds(['analyze', 'refresh'])).toEqual(['analyze', 'refresh']);
  b.record('analyze', false);
  b.record('analyze', false);
  expect(b.isOpen('analyze')).toBe(false);
  expect(b.filterKinds(['analyze', 'refresh'])).toEqual(['analyze', 'refresh']);
});

test('threshold failures park the kind for the cooldown, then half-open', () => {
  let t = 0;
  const b = createKindBreaker({ threshold: 2, cooldownMs: 60_000, now: () => t });
  b.record('refresh', false);
  b.record('refresh', false);
  expect(b.isOpen('refresh')).toBe(true);
  expect(b.filterKinds(['analyze', 'refresh'])).toEqual(['analyze']);
  t += 59_999;
  expect(b.isOpen('refresh')).toBe(true);
  t += 1;
  expect(b.isOpen('refresh')).toBe(false);
  expect(b.filterKinds(['analyze', 'refresh'])).toEqual(['analyze', 'refresh']);
});

test('a success resets the streak and clears a park', () => {
  let t = 0;
  const b = createKindBreaker({ threshold: 2, cooldownMs: 60_000, now: () => t });
  b.record('fetch', false);
  b.record('fetch', true);
  b.record('fetch', false);
  expect(b.isOpen('fetch')).toBe(false);
  b.record('fetch', false);
  expect(b.isOpen('fetch')).toBe(true);
  b.record('fetch', true);
  expect(b.isOpen('fetch')).toBe(false);
});

test('other kinds are unaffected by one parked kind', () => {
  let t = 0;
  const b = createKindBreaker({ threshold: 1, cooldownMs: 60_000, now: () => t });
  b.record('analyze', false);
  expect(b.filterKinds(['analyze', 'fetch', 'rescore'])).toEqual(['fetch', 'rescore']);
});
