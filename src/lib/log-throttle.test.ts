// Throttled log lines — the first occurrence always gets through, and nothing
// is silently dropped. See src/lib/log-throttle.ts.
import { describe, expect, test } from 'bun:test';

import { createThrottle, foldedSuffix } from './log-throttle.js';

/** Clock the test advances by hand, so no test sleeps. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createThrottle', () => {
  test('emits the first occurrence immediately', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 60_000, now: clock.now });
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
  });

  test('folds occurrences inside the window and reports the count next time', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 60_000, now: clock.now });
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
    // Inside the window: three silent passes, no formatting cost paid.
    for (let i = 0; i < 3; i++) {
      clock.advance(10_000);
      expect(throttle.take('k', () => 'never built')).toBeNull();
    }
    expect(throttle.folded('k')).toBe(3);
    // Window elapsed: one line, carrying the three that were folded.
    clock.advance(60_000);
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 3');
    expect(throttle.folded('k')).toBe(0);
  });

  test('does not build the message for a folded occurrence', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 60_000, now: clock.now });
    throttle.take('k', (n) => `line ${n}`);
    let built = 0;
    clock.advance(1_000);
    throttle.take('k', () => { built++; return 'x'; });
    expect(built).toBe(0);
  });

  test('keys are independent — one noisy key never hides another', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 60_000, now: clock.now });
    expect(throttle.take('a', (n) => `a ${n}`)).toBe('a 0');
    clock.advance(1_000);
    expect(throttle.take('a', () => 'x')).toBeNull();
    // b has never emitted, so it must not be silenced by a's traffic.
    expect(throttle.take('b', (n) => `b ${n}`)).toBe('b 0');
  });

  test('exactly at the window boundary emits; one ms before it stays folded', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 1_000, now: clock.now });
    throttle.take('k', () => 'first');
    clock.advance(999);
    expect(throttle.take('k', () => 'x')).toBeNull();
    clock.advance(1);
    expect(throttle.take('k', () => 'after window')).toBe('after window');
  });

  test('everyMs 0 disables throttling — a caller can never lose the line', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 0, now: clock.now });
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
    clock.advance(1);
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
    expect(throttle.folded('k')).toBe(0);
  });

  test('a negative/NaN window falls back to unthrottled rather than dropping lines', () => {
    const throttle = createThrottle({ everyMs: Number.NaN, now: () => 0 });
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
  });

  test('reset makes the next occurrence the new first line', () => {
    const clock = fakeClock();
    const throttle = createThrottle({ everyMs: 60_000, now: clock.now });
    throttle.take('k', (n) => `line ${n}`);
    clock.advance(1_000);
    expect(throttle.take('k', () => 'x')).toBeNull();
    throttle.reset('k');
    expect(throttle.folded('k')).toBe(0);
    expect(throttle.take('k', (n) => `line ${n}`)).toBe('line 0');
  });
});

describe('foldedSuffix', () => {
  test('is empty when nothing was folded, so the common case reads clean', () => {
    expect(foldedSuffix(0)).toBe('');
  });
  test('names the count when lines were withheld', () => {
    expect(foldedSuffix(12)).toBe(' (+12 folded)');
  });
});
