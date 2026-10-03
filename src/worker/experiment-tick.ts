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
