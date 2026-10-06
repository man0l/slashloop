// SLA-550: every paid QA correction wave is its own durable debit, taken before the provider call,
// against the same experiment credit cap and wallet as the first wave, and refundable by its own receipt.
import { describe, test, expect } from 'bun:test';
import { step, type EngineDeps } from './engine.js';
import { TerminalFailure, SafeFailure, type ExecuteContext } from './providers.js';
import { ExperimentError, qaMaxAttempts, slideRequestAllowance, SLIDE_FANOUT, type BriefData, type Experiment } from './schema.js';
import { serialize } from './store.js';
import { taskCost } from './service.js';
import { InsufficientCreditsError } from '../lib/credits.js';

const instructions = { goal: 'Sell tea', brand: 'Tea', audience: 'Adults', language: 'English', direction: 'Calm', lockedConstraints: [], variables: ['hook' as const], mode: 'controlled' as const };
const brief: BriefData = { concept: 'Tea routine', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: 'Tea time', cta: '', lockedConstraints: [], slides: Array.from({ length: 3 }, (_, i) => ({ role: i ? 'body' : 'hook', scene: 'Tea cup', overlayText: '' })) };
const UNIT = taskCost({ kind: 'slide' });
const FANOUT = 3;

function fixture(maxCredits: number): Experiment {
  const v = { id: 'v1', revision: 1, status: 'generating', baselineId: null, generationBasis: 'text-directed' as const, history: [], title: 'B', hypothesis: 'h', changedVariables: [], brief, frozenBrief: brief, slides: [{ index: 0, status: 'pending', url: null, path: null, error: null, overlayText: '' }], error: null };
  return { id: 'e', workspaceId: 'w', status: 'generating', version: 0, createdAt: '', updatedAt: '', instructions, variantCount: 1, slideCount: 3, maxCredits, creditsCharged: 0, report: null, inputs: [], variants: [v], error: null, generationBasis: 'text-directed', assetPolicy: 'retained', tasks: [{ id: 'b', kind: 'briefs', status: 'done', attempts: 1, charged: 0 }, { id: 's0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 0 }], commands: {}, allowPartial: false, createFingerprint: 'x' } as Experiment;
}

/** Mirrors the store's contract: CAS on version, the experiment cap throws, the ledger is keyed by ref. */
function harness(maxCredits: number, execute: (ctx: ExecuteContext | undefined) => Promise<unknown>, opts: { walletUnits?: number } = {}) {
  let row = fixture(maxCredits);
  const ledger = new Map<string, number>();
  let wallet = opts.walletUnits === undefined ? Infinity : opts.walletUnits * UNIT;
  const deps: EngineDeps = {
    load: async () => structuredClone(row),
    save: async (e, charge = 0, ref) => {
      if (e.version !== row.version) return false;
      if (charge > 0 && row.creditsCharged + charge > e.maxCredits) throw new ExperimentError(409, 'experiment_budget_exceeded');
      if (charge > wallet) throw new InsufficientCreditsError('w', charge, wallet);
      wallet -= charge;
      if (ref) ledger.set(ref, (ledger.get(ref) ?? 0) + charge);
      row = structuredClone({ ...e, version: e.version + 1, creditsCharged: row.creditsCharged + charge });
      Object.assign(e, row);
      return true;
    },
    prepare: async () => ({ units: FANOUT, execute }),
    now: () => 1000,
  };
  return { deps, get row() { return row; }, ledger, get net() { return [...ledger.values()].reduce((a, b) => a + b, 0); }, get task() { return row.tasks.find(t => t.id === 's0')!; } };
}
const done = { path: 'p/0.jpg', url: 'https://thumbs.test/p/0.jpg', model: 'm', provider: 'openrouter', costUsd: 0, prompt: 'p', reference: null, fanout: { requested: 3, rendered: 3, chosen: 0, judge: [] }, story: { verdict: 'pass', contractHash: 'h', corrected: true, attempts: 3, reasons: [], checks: [] } };
const audit = { verdict: 'fail', contractHash: 'abc', corrected: true, attempts: 3, reasons: ['subject missing'], checks: [] };

describe('paid QA corrections are admitted durably before the provider call', () => {
  test('each admitted wave is a separate debit, counted as provider requests, inside the cap', async () => {
    const asked: boolean[] = [];
    const h = harness(100 * UNIT, async ctx => { asked.push(await ctx!.admit(FANOUT), await ctx!.admit(FANOUT)); return done; });
    await step('w', 'e', h.deps);
    expect(asked).toEqual([true, true]);
    expect(h.row.creditsCharged).toBe(3 * FANOUT * UNIT);
    expect(h.task.requests).toBe(3 * FANOUT);
    expect([...h.ledger.keys()].filter(k => /:qa\d+$/.test(k))).toHaveLength(2);
    expect(h.task.charged).toBe(3 * FANOUT * UNIT);
  });

  test('a correction that would pass the experiment cap is refused with nothing charged', async () => {
    let admitted: boolean | undefined;
    const h = harness(FANOUT * UNIT + 1, async ctx => { admitted = await ctx!.admit(FANOUT); throw new TerminalFailure('story_check_failed:x', 'failed', audit); });
    await step('w', 'e', h.deps);
    expect(admitted).toBe(false);
    expect(h.row.creditsCharged).toBeLessThanOrEqual(h.row.maxCredits);
    expect(h.task.requests).toBe(FANOUT);
    expect([...h.ledger.keys()].some(k => /:qa\d+$/.test(k))).toBe(false);
  });

  test('a wallet that cannot cover the wave refuses it instead of failing the task', async () => {
    let admitted: boolean | undefined;
    const h = harness(100 * UNIT, async ctx => { admitted = await ctx!.admit(FANOUT); return done; }, { walletUnits: FANOUT });
    await step('w', 'e', h.deps);
    expect(admitted).toBe(false);
    expect(h.task.status).toBe('done');
    expect(h.row.creditsCharged).toBe(FANOUT * UNIT);
  });

  test('requests never exceed the per-attempt allowance (fan-out x QA max attempts)', async () => {
    const grants: boolean[] = [];
    const h = harness(1000 * UNIT, async ctx => { for (let i = 0; i < 6; i++) grants.push(await ctx!.admit(FANOUT)); return done; });
    await step('w', 'e', h.deps);
    expect(grants.filter(Boolean)).toHaveLength(2);
    expect(h.task.requests).toBe(FANOUT * 3);
  });

  test('a known failure refunds the first wave and every correction by its own ref', async () => {
    const h = harness(100 * UNIT, async ctx => { await ctx!.admit(FANOUT); await ctx!.admit(FANOUT); throw new SafeFailure('invalid_image_size'); });
    await step('w', 'e', h.deps);
    expect(h.net).toBe(0);
    expect(h.row.creditsCharged).toBe(0);
    expect(h.task.corrections ?? []).toHaveLength(0);
    expect(h.task.charged).toBe(0);
  });

  test('a verified QA failure settles like every known failure: each receipt refunded, nothing orphaned', async () => {
    const h = harness(100 * UNIT, async ctx => { await ctx!.admit(FANOUT); await ctx!.admit(FANOUT); throw new TerminalFailure('story_check_failed:x', 'failed', audit); });
    await step('w', 'e', h.deps);
    expect(h.net).toBe(0);
    expect(h.row.creditsCharged).toBe(0);
    expect(h.task.status).toBe('failed');
  });

  test('an unknown failure retains the debits and requeues without a free retry of the paid waves', async () => {
    const h = harness(100 * UNIT, async ctx => { await ctx!.admit(FANOUT); throw new Error('socket lost'); });
    await step('w', 'e', h.deps);
    expect(h.task.status).toBe('pending');
    expect(h.row.creditsCharged).toBe(2 * FANOUT * UNIT);
    expect(h.task.requests).toBe(2 * FANOUT);
  });

  test('a free prepared task is never admitted', async () => {
    let admitted: boolean | undefined;
    const h = harness(100 * UNIT, async ctx => { admitted = await ctx!.admit(1); return done; });
    h.deps.prepare = async () => ({ free: true, execute: async ctx => { admitted = await ctx!.admit(1); return done; } });
    await step('w', 'e', h.deps);
    expect(admitted).toBe(false);
    expect(h.row.creditsCharged).toBe(0);
  });
});

describe('counters and ceilings include internal attempts', () => {
  test('the request allowance is fan-out x QA attempts, bounded by the knob and its cap', () => {
    expect(slideRequestAllowance(3, {} as NodeJS.ProcessEnv)).toBe(9);
    expect(slideRequestAllowance(3, { EXPERIMENT_QA_MAX_ATTEMPTS: '1' } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(slideRequestAllowance(3, { EXPERIMENT_QA_MAX_ATTEMPTS: '99' } as unknown as NodeJS.ProcessEnv)).toBe(15);
    expect(qaMaxAttempts({ EXPERIMENT_QA_MAX_ATTEMPTS: 'x' } as unknown as NodeJS.ProcessEnv)).toBe(3);
  });

  test('providerBudget counts every started request, corrections included, against the worst case', async () => {
    const h = harness(100 * UNIT, async ctx => { await ctx!.admit(FANOUT); return done; });
    await step('w', 'e', h.deps);
    const budget = (serialize(h.row) as { providerBudget: { maxRequests: number; requestsStarted: number } }).providerBudget;
    expect(budget.requestsStarted).toBe(2 * FANOUT + 1); // the done briefs call counts its one attempt
    expect(budget.maxRequests).toBeGreaterThanOrEqual(2 * h.row.variantCount * h.row.slideCount * SLIDE_FANOUT * qaMaxAttempts());
  });
});
