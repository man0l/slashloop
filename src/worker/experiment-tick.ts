// ---------------------------------------------------------------------------
// Experiment-tick ownership for the VPS worker loop (pure, unit-tested).
//
// Single leader: every VPS container runs the drain loop, but only ONE may
// tick experiments (each tick is Experiment UPDATEs + debits + ledger
// INSERTs — N containers ticking means N× the D1 writes). Default owner is
// the maintenance (refresh-draining) worker; EXPERIMENT_TICK_ENABLED=1
// forces on, =0 forces off.
//
// Kept out of worker/index.ts so the gating logic is importable without
// running the drain loop — and so the module-evaluation order in index.ts
// can never reintroduce the TDZ crash that parked all workers (the gating
// call must run after KINDS is initialized; taking kinds as a parameter
// makes that dependency explicit).
// ---------------------------------------------------------------------------

import { errorDetail } from '../lib/error-detail.js';

/**
 * Detail for the tick-failure log line. The line must never end at the
 * colon: 2026-10-02 production logged
 * `[worker] experiment tick failed (streak 1, next attempt in ~5s): `
 * with nothing after it — the running build's catch was
 * `err.stack ?? err.message`, and both can be empty strings on a real
 * Error (`??` only falls through on null/undefined).
 *
 * errorDetail() already returns a non-empty string for every thrown shape,
 * but the guarantee lives next to the log line so a future change to
 * errorDetail cannot silently recreate the blind spot (SLA-362). The
 * fallback names the thrown value's shape — typeof + constructor + safe
 * JSON — so a non-Error throw is diagnosable from the log line alone.
 */
export function experimentTickFailureDetail(err: unknown): string {
  const detail = errorDetail(err);
  if (detail) return detail;
  let shape = '';
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') shape = json;
  } catch {
    // Circular / non-serialisable — fall through to String().
  }
  if (!shape) shape = String(err);
  const ctor =
    err && typeof err === 'object' && typeof err.constructor === 'function'
      ? ` ctor=${err.constructor.name}`
      : '';
  return `no detail extractable from thrown value (typeof ${typeof err}${ctor}): ${shape || '?'}`;
}

// ---------------------------------------------------------------------------
// Cadence: how often the loop is allowed to re-tick experiments.
//
// The engine reports active=true whenever an experiment row exists — including
// when this tick attempted nothing at all (every task is inside its lease or
// backing off). The loop used to read `active && (steps === 0 ||
// usage.writes > 0)` as progress, so those zero-step waits reset the streak
// and re-armed the 5s fast cadence forever: an active-but-idle experiment
// polled D1 every 5s and IDLE_TICK_STREAK_MAX was unreachable.
//
// The decision below is tick-LOCAL. `steps` comes from this tick's engine
// call; deltaD1Usage() is process-wide, so MediaJob draining concurrently
// inflates `writes` during an experiment tick and runtimes without
// D1-over-HTTP keep the totals at 0. Writes stay a logging signal only.
// ---------------------------------------------------------------------------

/** Re-tick interval while the fast window is armed. */
export const EXPERIMENT_TICK_MIN_INTERVAL_MS = 5_000;
/** Re-tick interval once the fast window is not armed. */
export const EXPERIMENT_TICK_SLOW_INTERVAL_MS = 120_000;
/** How long one progress tick keeps the fast window armed. */
export const EXPERIMENT_ACTIVE_WINDOW_MS = 10 * 60_000;
/** Consecutive no-progress ticks before an active experiment parks to slow cadence. */
export const IDLE_TICK_STREAK_MAX = 3;

export interface ExperimentCadence {
  /** Absolute ms until which the fast window is armed (0 = parked). */
  activeUntil: number;
  /** Consecutive active ticks that attempted nothing. */
  idleTickStreak: number;
}

export interface ExperimentTickOutcome {
  /** Steps this tick actually ran (the engine's `steps`). */
  steps: number;
  /** Engine `active`: an experiment row exists, progress or not. */
  active: boolean;
}

export interface ExperimentCadenceDecision extends ExperimentCadence {
  /** True when this tick made progress and re-armed the fast window. */
  rearmed: boolean;
  /** Streak length that parked the loop to the slow cadence; null otherwise. */
  parkedStreak: number | null;
}

/** Minimum gap the loop must leave between experiment ticks, right now. */
export function experimentTickIntervalMs(activeUntil: number, now: number): number {
  return now < activeUntil ? EXPERIMENT_TICK_MIN_INTERVAL_MS : EXPERIMENT_TICK_SLOW_INTERVAL_MS;
}

/**
 * Next cadence state after one tick.
 *
 *   • no experiment rows  → clear the fast window and the streak
 *   • steps > 0           → real progress: re-arm the fast window, streak = 0
 *   • active, steps === 0 → lease/backoff wait: count it, park at
 *                           IDLE_TICK_STREAK_MAX no-progress ticks
 *
 * An inactive tick wins over a step count because a tick that made progress
 * always has candidates; if the engine ever returns the impossible pair
 * (steps > 0, active false), clearing the window is the cheap direction.
 */
export function nextExperimentCadence(
  prev: ExperimentCadence,
  tick: ExperimentTickOutcome,
  now: number,
): ExperimentCadenceDecision {
  if (!tick.active) {
    return { activeUntil: 0, idleTickStreak: 0, rearmed: false, parkedStreak: null };
  }
  if (tick.steps > 0) {
    return {
      activeUntil: now + EXPERIMENT_ACTIVE_WINDOW_MS,
      idleTickStreak: 0,
      rearmed: true,
      parkedStreak: null,
    };
  }
  const streak = prev.idleTickStreak + 1;
  if (streak >= IDLE_TICK_STREAK_MAX) {
    return { activeUntil: 0, idleTickStreak: 0, rearmed: false, parkedStreak: streak };
  }
  return { activeUntil: prev.activeUntil, idleTickStreak: streak, rearmed: false, parkedStreak: null };
}

/** True when this container owns the experiment tick. */
export function experimentsTickEnabled(
  kinds: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return describeExperimentTickGate(kinds, env).enabled;
}

/**
 * Why the experiment tick is on or off on this container — surfaced in the
 * worker startup banner so a parked experiment is visible in the logs instead
 * of silent (2026-09-28: EXPERIMENT_TICK_ENABLED=0 on every container froze
 * all experiments with no log line saying why).
 */
export function describeExperimentTickGate(
  kinds: string[],
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; reason: string } {
  const raw = (env.EXPERIMENT_TICK_ENABLED ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes')
    return { enabled: true, reason: 'EXPERIMENT_TICK_ENABLED=1 (forced on)' };
  if (raw === '0' || raw === 'false' || raw === 'no')
    return { enabled: false, reason: 'EXPERIMENT_TICK_ENABLED=0 (forced off)' };
  if (kinds.includes('refresh'))
    return { enabled: true, reason: 'default leader (drains refresh)' };
  return { enabled: false, reason: `not the leader (kinds=[${kinds.join(', ')}], no refresh)` };
}
