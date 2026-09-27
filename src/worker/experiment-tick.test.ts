// Regression: the VPS worker entry must not read KINDS before initialization.
// c9f7f67 evaluated the experiment-tick gate above the KINDS declaration — a
// TDZ ReferenceError at module load that crash-looped all three worker
// containers at startup (observed live 2026-09-27; queue fully stalled).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimentsTickEnabled } from './experiment-tick.js';

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
    const firstUse = src.indexOf('experimentsTickEnabled(KINDS)');
    expect(firstUse).toBeGreaterThan(-1);
    expect(kindsDecl).toBeLessThan(firstUse);
    // And no zero-arg call that could close over a later global.
    expect(src).not.toContain('experimentsTickEnabled()');
  });
});
