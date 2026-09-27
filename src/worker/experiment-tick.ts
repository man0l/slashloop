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

/** True when this container owns the experiment tick. */
export function experimentsTickEnabled(
  kinds: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.EXPERIMENT_TICK_ENABLED ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return kinds.includes('refresh');
}
