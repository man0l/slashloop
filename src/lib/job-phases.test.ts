import { expect, test } from 'bun:test';
import { markPhase, PhaseTracker, withPhaseTracker } from './job-phases.js';

test('summary reports per-phase seconds and flags the in-flight phase', async () => {
  let t = 0;
  const tracker = new PhaseTracker(() => t);
  await withPhaseTracker(tracker, async () => {
    t = 100; markPhase('scrape');
    t = 85_100; markPhase('score');
    t = 120_000;
  });
  expect(tracker.summary()).toBe('start 0.1s > scrape 85.0s > score 34.9s (running)');
});

test('markPhase outside a scope is a no-op', () => {
  expect(() => markPhase('x')).not.toThrow();
});

test('concurrent scopes do not bleed into each other', async () => {
  const a = new PhaseTracker(); const b = new PhaseTracker();
  await Promise.all([
    withPhaseTracker(a, async () => { await Promise.resolve(); markPhase('only-a'); }),
    withPhaseTracker(b, async () => { await Promise.resolve(); markPhase('only-b'); }),
  ]);
  expect(a.summary()).toContain('only-a');
  expect(a.summary()).not.toContain('only-b');
  expect(b.summary()).toContain('only-b');
});
