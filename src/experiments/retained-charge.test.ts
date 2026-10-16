import { describe, test, expect } from 'bun:test';
import { step, type EngineDeps } from './engine.js';
import type { Experiment } from './schema.js';
import { taskCost } from './service.js';

function fixture(): Experiment {
  return {
    id: 'e', workspaceId: 'w', status: 'generating', version: 0, createdAt: '', updatedAt: '',
    instructions: { goal: 'g', brand: 'b', audience: 'a', language: 'English', direction: 'd', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 1, slideCount: 1, maxCredits: 1000, creditsCharged: 0, report: null, inputs: [],
    variants: [{ id: 'v', baselineId: null, revision: 1, status: 'generating', slides: [{ status: 'pending', error: null }], history: [], frozenBrief: null, error: null }],
    error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    tasks: [{ id: 'b', kind: 'briefs', target: 'e', status: 'done', attempts: 1, charged: 0 }, { id: 't', kind: 'slide', target: 'v', index: 0, status: 'pending', attempts: 0, charged: 0 }],
    commands: {}, allowPartial: false, createFingerprint: 'x',
  } as unknown as Experiment;
}

function harness(outcomes: Array<'unknown' | 'ok'>) {
  let row = fixture();
  const debits: Array<{ ref?: string; amount: number }> = [];
  let now = 1000;
  const deps: EngineDeps = {
    load: async () => structuredClone(row),
    save: async (e, charge = 0, ref, refunds = []) => {
      if (e.version !== row.version) return false;
      const refunded = refunds.reduce((n, r) => n + r.amount, 0);
      row = structuredClone({ ...e, version: e.version + 1, creditsCharged: e.creditsCharged + charge - refunded });
      if (charge > 0) debits.push({ ref, amount: charge });
      for (const r of refunds) debits.push({ ref: r.ref, amount: -r.amount });
      if (charge < 0) debits.push({ ref, amount: charge });
      Object.assign(e, row);
      return true;
    },
    prepare: async () => ({
      execute: async () => {
        const next = outcomes.shift();
        if (next === 'unknown') throw new Error('socket lost');
        return { path: 'p', url: 'u' };
      },
    }),
    now: () => now,
  } as EngineDeps;
  return { deps, debits, get row() { return row; }, advance: () => { now += 3_600_000; } };
}

describe('retained charge of an unknown-outcome attempt (SLA-891)', () => {
  test('a slide that succeeds on attempt 2 is billed once', async () => {
    const h = harness(['unknown', 'ok']);
    await step('w', 'e', h.deps);
    const price = taskCost(h.row.tasks.find(x => x.id === 't')!);
    expect(h.row.tasks.find(x => x.id === 't')!.status).toBe('pending');
    expect(h.row.creditsCharged).toBe(price);
    expect(h.row.tasks.find(x => x.id === 't')!.retained).toEqual([{ ref: 'experiment:e:t:1', charged: price }]);

    h.advance();
    await step('w', 'e', h.deps);
    const task = h.row.tasks.find(x => x.id === 't')!;
    expect(task.status).toBe('done');
    expect(task.attempts).toBe(2);
    expect(h.row.creditsCharged).toBe(price);
    expect(task.charged).toBe(price);
    expect(task.retained).toBeUndefined();
    expect(h.debits).toEqual([
      { ref: 'experiment:e:t:1', amount: price },
      { ref: 'experiment:e:t:2', amount: price },
      { ref: 'experiment:e:t:1', amount: -price },
    ]);
  });

  test('when every attempt stays unknown the retained charges are kept', async () => {
    const h = harness(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    for (let i = 0; i < 6; i++) { h.advance(); await step('w', 'e', h.deps); }
    const task = h.row.tasks.find(x => x.id === 't')!;
    expect(task.status).not.toBe('done');
    expect(h.row.creditsCharged).toBe(task.charged);
    expect(task.charged).toBeGreaterThan(0);
  });
});
