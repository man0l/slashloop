// Regression: the VPS worker entry must not read KINDS before initialization.
// c9f7f67 evaluated the experiment-tick gate above the KINDS declaration — a
// TDZ ReferenceError at module load that crash-looped all three worker
// containers at startup (observed live 2026-09-27; queue fully stalled).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeExperimentTickGate, experimentsTickEnabled, experimentTickFailureDetail,
  nextExperimentCadence, experimentTickIntervalMs,
  EXPERIMENT_ACTIVE_WINDOW_MS, EXPERIMENT_TICK_MIN_INTERVAL_MS, EXPERIMENT_TICK_SLOW_INTERVAL_MS,
  IDLE_TICK_STREAK_MAX,
} from './experiment-tick.js';

describe('experimentsTickEnabled', () => {
  test('explicit env wins over kinds', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', ' Yes ']) {
      expect(experimentsTickEnabled(['analyze'], { EXPERIMENT_TICK_ENABLED: v } as NodeJS.ProcessEnv)).toBe(true);
      expect(experimentsTickEnabled(['refresh'], { EXPERIMENT_TICK_ENABLED: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'FALSE', ' No ']) {
      expect(experimentsTickEnabled(['refresh'], { EXPERIMENT_TICK_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
      expect(experimentsTickEnabled(['analyze'], { EXPERIMENT_TICK_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  test('unset env defaults to the refresh-draining (maintenance) worker', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(experimentsTickEnabled(['refresh', 'discover'], env)).toBe(true);
    expect(experimentsTickEnabled(['analyze', 'fetch', 'thumb'], env)).toBe(false);
    expect(experimentsTickEnabled([], env)).toBe(false);
  });
});

describe('describeExperimentTickGate', () => {
  test('reason names the exact gate so the startup banner explains a parked tick', () => {
    expect(describeExperimentTickGate(['refresh'], { EXPERIMENT_TICK_ENABLED: '0' } as NodeJS.ProcessEnv))
      .toEqual({ enabled: false, reason: 'EXPERIMENT_TICK_ENABLED=0 (forced off)' });
    expect(describeExperimentTickGate(['analyze'], { EXPERIMENT_TICK_ENABLED: '1' } as NodeJS.ProcessEnv))
      .toEqual({ enabled: true, reason: 'EXPERIMENT_TICK_ENABLED=1 (forced on)' });
    expect(describeExperimentTickGate(['refresh', 'discover'], {} as NodeJS.ProcessEnv))
      .toEqual({ enabled: true, reason: 'default leader (drains refresh)' });
    const off = describeExperimentTickGate(['analyze'], {} as NodeJS.ProcessEnv);
    expect(off.enabled).toBe(false);
    expect(off.reason).toContain('not the leader');
    // enabled flag always agrees with experimentsTickEnabled.
    for (const kinds of [['refresh'], ['analyze'], [], ['rescore']]) {
      for (const env of [{}, { EXPERIMENT_TICK_ENABLED: '0' }, { EXPERIMENT_TICK_ENABLED: '1' }]) {
        expect(describeExperimentTickGate(kinds, env as NodeJS.ProcessEnv).enabled)
          .toBe(experimentsTickEnabled(kinds, env as NodeJS.ProcessEnv));
      }
    }
  });
});

describe('worker entry evaluation order', () => {
  test('KINDS is initialized before its first module-load use', () => {
    // Static guard: index.ts has a top-level drain loop, so it cannot be
    // imported in tests — assert on source order instead. The gating call
    // takes KINDS as an explicit parameter (see experiment-tick.ts), so the
    // only remaining hazard is declaration order.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const kindsDecl = src.indexOf('const KINDS = workerKinds();');
    expect(kindsDecl).toBeGreaterThan(-1);
    const firstUse = src.indexOf('describeExperimentTickGate(KINDS)');
    expect(firstUse).toBeGreaterThan(-1);
    expect(kindsDecl).toBeLessThan(firstUse);
    // And no zero-arg call that could close over a later global.
    expect(src).not.toContain('describeExperimentTickGate()');
  });
});

describe('experimentTickFailureDetail', () => {
  // 2026-10-02 production logged `[worker] experiment tick failed (streak 1,
  // next attempt in ~5s): ` — nothing after the colon — because the running
  // build's catch was `err.stack ?? err.message` and both were empty strings.
  // The log line must never end at the colon again, for any thrown shape.
  const thrownShapes: Array<[string, unknown]> = [
    ['Error with message', new Error('ConnectionRefused: Unable to connect. Is the computer able to access the url?')],
    ['Error with empty message and stack', Object.assign(new Error(''), { stack: '' })],
    ['anonymous Error subclass with no message', new (class extends Error {})()],
    ['whitespace-only Error message', new Error('   ')],
    ['empty string', ''],
    ['whitespace string', '   '],
    ['plain string', 'upstream 503'],
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['number', 42],
    ['boolean', true],
    ['symbol', Symbol('sym')],
    ['bigint', 10n],
    ['empty object', {}],
    ['plain object', { code: 'ECONNREFUSED', errno: -111 }],
    ['circular object', (() => { const c: Record<string, unknown> = {}; c.self = c; return c; })()],
  ];

  test('never returns an empty string', () => {
    for (const [label, err] of thrownShapes) {
      const detail = experimentTickFailureDetail(err);
      expect(detail, `for ${label}`).not.toBe('');
      expect(detail.trim(), `for ${label}`).not.toBe('');
    }
  });

  test('keeps the errorDetail rendering for normal throws', () => {
    const err = new Error('boom\n  at frame');
    expect(experimentTickFailureDetail(err)).toBe(err.stack!);
    expect(experimentTickFailureDetail('upstream 503')).toBe('upstream 503');
    expect(experimentTickFailureDetail({ code: 'ECONNREFUSED' })).toBe('{"code":"ECONNREFUSED"}');
  });

  test('index.ts tick-failure line routes through the non-empty guard', () => {
    // Static guard: index.ts has a top-level drain loop, so it cannot be
    // imported in tests — assert on the source instead. A future edit that
    // drops back to a bare `err.stack ?? err.message` would re-open the
    // empty-detail blind spot (SLA-362).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const line = src.indexOf('[worker] experiment tick failed');
    expect(line).toBeGreaterThan(-1);
    const catchWindow = src.slice(Math.max(0, line - 500), line);
    expect(catchWindow).toContain('experimentTickFailureDetail(');
    expect(catchWindow).not.toContain('err.stack ?? err.message');
  });
});

// ---------------------------------------------------------------------------
// SLA-455: an active experiment whose tick runs zero steps is a lease/backoff
// wait, not progress. The loop used to read `active && (steps === 0 ||
// usage.writes > 0)` as progress, which reset the streak and re-armed the 5s
// cadence on every no-op tick — IDLE_TICK_STREAK_MAX was unreachable, so idle
// experiments polled D1 every 5s instead of parking at 120s.
//
// The loop body is not importable (top-level drain loop in index.ts), so the
// cadence policy lives in nextExperimentCadence() and is exercised here with
// an explicit fake clock — no timers, no network, no provider calls.
// ---------------------------------------------------------------------------

/**
 * One fake worker-loop iteration: the interval in force when the loop wakes,
 * the sleep it actually takes, and the cadence state after folding the tick
 * outcome. The loop starts parked (activeUntil 0) and lastTickAt 0, so the
 * first tick fires immediately no matter the interval — as index.ts does.
 */
function fakeLoop(ticks: Array<{ steps: number; active: boolean }>) {
  let now = 1_700_000_000_000;
  let lastTickAt = 0;
  let state = { activeUntil: 0, idleTickStreak: 0 };
  const intervalMs: number[] = [];
  const sleptMs: number[] = [];
  const parkedStreak: (number | null)[] = [];
  const rearmed: boolean[] = [];
  for (const tick of ticks) {
    const interval = experimentTickIntervalMs(state.activeUntil, now);
    const sleep = Math.max(0, interval - (now - lastTickAt));
    now += sleep;
    lastTickAt = now;
    const decision = nextExperimentCadence(state, tick, now);
    state = { activeUntil: decision.activeUntil, idleTickStreak: decision.idleTickStreak };
    intervalMs.push(interval);
    sleptMs.push(sleep);
    parkedStreak.push(decision.parkedStreak);
    rearmed.push(decision.rearmed);
  }
  return { intervalMs, sleptMs, parkedStreak, rearmed, state };
}

const PROGRESS = { steps: 1, active: true };
/** The leased/backed-off case: an experiment row exists, this tick ran nothing. */
const NO_PROGRESS = { steps: 0, active: true };
const NO_EXPERIMENTS = { steps: 0, active: false };
const FAST = EXPERIMENT_TICK_MIN_INTERVAL_MS;
const SLOW = EXPERIMENT_TICK_SLOW_INTERVAL_MS;

describe('nextExperimentCadence', () => {
  test('cadence constants are the shipped values', () => {
    expect(FAST).toBe(5_000);
    expect(SLOW).toBe(120_000);
    expect(IDLE_TICK_STREAK_MAX).toBe(3);
    expect(EXPERIMENT_ACTIVE_WINDOW_MS).toBe(600_000);
  });

  test('active zero-step ticks count toward the streak and park at the slow cadence', () => {
    // 1 progress tick (arms the window), then IDLE_TICK_STREAK_MAX no-progress
    // ticks. The loop starts parked, so tick 1 wakes on the slow cadence.
    const run = fakeLoop([PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_PROGRESS]);
    expect(run.intervalMs).toEqual([SLOW, FAST, FAST, FAST, SLOW, SLOW]);
    expect(run.parkedStreak).toEqual([null, null, null, IDLE_TICK_STREAK_MAX, null, null]);
    expect(run.state.activeUntil).toBe(0);
    // The streak restarts after parking — a still-active experiment must not
    // re-warn (or re-park) on every subsequent slow tick.
    expect(run.state.idleTickStreak).toBe(2);
  });

  test('three no-progress ticks are required: two still hold the fast window', () => {
    const run = fakeLoop([PROGRESS, NO_PROGRESS, NO_PROGRESS]);
    expect(run.parkedStreak).toEqual([null, null, null]);
    expect(run.intervalMs).toEqual([SLOW, FAST, FAST]);
    expect(run.state.idleTickStreak).toBe(2);
    expect(run.state.activeUntil).toBeGreaterThan(0);
    expect(experimentTickIntervalMs(run.state.activeUntil, 1_700_000_000_000)).toBe(FAST);
  });

  test('a tick with real progress re-arms the 5s cadence after a park', () => {
    const parked = fakeLoop([PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_PROGRESS]);
    expect(parked.state.activeUntil).toBe(0);
    // Tick 5 lands on the slow cadence, runs 2 steps, and the iteration after
    // it is back to 5s.
    const resumed = fakeLoop([
      PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_PROGRESS,
      { steps: 2, active: true }, PROGRESS,
    ]);
    expect(resumed.intervalMs).toEqual([SLOW, FAST, FAST, FAST, SLOW, FAST]);
    expect(resumed.rearmed).toEqual([true, false, false, false, true, true]);
    expect(resumed.parkedStreak).toEqual([null, null, null, IDLE_TICK_STREAK_MAX, null, null]);
    expect(resumed.state.idleTickStreak).toBe(0);
  });

  test('an inactive tick clears the streak and the fast window', () => {
    const run = fakeLoop([PROGRESS, NO_PROGRESS, NO_PROGRESS, NO_EXPERIMENTS, NO_PROGRESS]);
    // Tick 4 (inactive) drops the window and zeroes the streak, so tick 5 is
    // streak 1 and does NOT park — the reset is observable.
    expect(run.parkedStreak).toEqual([null, null, null, null, null]);
    expect(run.state.activeUntil).toBe(0);
    expect(run.state.idleTickStreak).toBe(1);
    expect(run.intervalMs).toEqual([SLOW, FAST, FAST, FAST, SLOW]);
  });

  test('an inactive tick wins over an impossible progress count', () => {
    // The engine always pairs steps>0 with active=true; if it ever did not,
    // clearing the window is the cheap direction.
    const decision = nextExperimentCadence({ activeUntil: 5, idleTickStreak: 2 }, { steps: 3, active: false }, 0);
    expect(decision).toEqual({ activeUntil: 0, idleTickStreak: 0, rearmed: false, parkedStreak: null });
  });

  test('D1 writes never decide cadence (process-wide counter attribution)', () => {
    // deltaD1Usage() is process-wide: MediaJob work draining concurrently
    // inflates writes mid-tick, and non-D1 runtimes keep the totals at 0. The
    // decision takes no usage input at all, so neither case can re-arm.
    const cold = { activeUntil: 0, idleTickStreak: 0 };
    expect(Object.keys(nextExperimentCadence(cold, NO_PROGRESS, 0)).sort()).toEqual([
      'activeUntil', 'idleTickStreak', 'parkedStreak', 'rearmed',
    ]);
    const a = nextExperimentCadence(cold, NO_PROGRESS, 0);
    const b = nextExperimentCadence(cold, NO_PROGRESS, 0);
    expect(a).toEqual(b);
  });
});

describe('experimentTickIntervalMs', () => {
  test('armed window → 5s, otherwise 120s', () => {
    expect(experimentTickIntervalMs(1_000, 999)).toBe(EXPERIMENT_TICK_MIN_INTERVAL_MS);
    expect(experimentTickIntervalMs(1_000, 1_000)).toBe(EXPERIMENT_TICK_SLOW_INTERVAL_MS);
    expect(experimentTickIntervalMs(0, 0)).toBe(EXPERIMENT_TICK_SLOW_INTERVAL_MS);
    // The armed window is exactly EXPERIMENT_ACTIVE_WINDOW_MS wide.
    expect(experimentTickIntervalMs(0 + EXPERIMENT_ACTIVE_WINDOW_MS, EXPERIMENT_ACTIVE_WINDOW_MS))
      .toBe(EXPERIMENT_TICK_SLOW_INTERVAL_MS);
  });
});

describe('worker loop cadence wiring', () => {
  // Static guards: index.ts cannot be imported (top-level drain loop), so the
  // invariants the loop must keep are pinned on its source instead.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  test('cadence routes through the tested pure function', () => {
    expect(src).toContain('nextExperimentCadence(');
    expect(src).toContain('experimentTickIntervalMs(experimentsActiveUntil, Date.now())');
    expect(src).toContain('experiment tick advanced');
    // The buggy re-arm disjunct must not come back.
    expect(src).not.toContain('steps === 0 ||');
    // And the cadence constants live in the tested module, not here.
    expect(src).not.toContain('const IDLE_TICK_STREAK_MAX');
    expect(src).not.toContain('const EXPERIMENT_TICK_MIN_INTERVAL_MS');
    expect(src).not.toContain('const EXPERIMENT_TICK_SLOW_INTERVAL_MS');
  });

  test('error backoff, single-flight, and gate ownership are unchanged', () => {
    // Error backoff: a failed tick parks itself behind the timestamp; a
    // successful tick clears it.
    expect(src).toContain('experimentTickErrorRounds++;');
    expect(src).toContain('experimentTickBackoffUntil = Date.now() + delay;');
    expect(src).toContain('experimentTickErrorRounds = 0;');
    expect(src).toContain('experimentTickBackoffUntil = 0;');
    // Single-flight: never start a tick while one is in the air.
    expect(src).toContain('!experimentTickInFlight');
    expect(src).toContain('experimentTickInFlight = experimentTick(120_000)');
    expect(src).toContain('.finally(() => { experimentTickInFlight = null; })');
    // Ownership + kill switch gate the tick, and still precede it.
    expect(src).toContain('const experimentsAllowed = doesExperiments && controlOn;');
    const gate = src.indexOf('const experimentsAllowed = doesExperiments && controlOn;');
    const tick = src.indexOf('experimentTickInFlight = experimentTick(120_000)');
    expect(gate).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(gate);
    // The cadence is a pure function of tick outcome + state — no side-effect
    // ordering to break: idleTickStreak/experimentsActiveUntil are only
    // assigned from the returned decision.
    expect(src).not.toContain('experimentsActiveUntil = Date.now() + 10 * 60_000');
    expect(src).toContain('experimentsActiveUntil = cadence.activeUntil;');
    expect(src).toContain('idleTickStreak = cadence.idleTickStreak;');
  });
});
