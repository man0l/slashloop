// Regression: the VPS worker entry must not read KINDS before initialization.
// c9f7f67 evaluated the experiment-tick gate above the KINDS declaration — a
// TDZ ReferenceError at module load that crash-looped all three worker
// containers at startup (observed live 2026-09-27; queue fully stalled).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeExperimentTickGate, experimentsTickEnabled, experimentTickFailureDetail } from './experiment-tick.js';

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
