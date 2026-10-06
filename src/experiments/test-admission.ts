import type { ExecuteContext } from './providers.js';

/** Test double for the engine's per-wave admission: grants waves while `waves` last and records every request. */
export function admission(waves = Infinity): ExecuteContext & { asked: number[]; granted: number } {
  const ctx = { asked: [] as number[], granted: 0, admit: async (units: number) => {
    ctx.asked.push(units);
    if (ctx.granted >= waves) return false;
    ctx.granted++;
    return true;
  } };
  return ctx;
}
