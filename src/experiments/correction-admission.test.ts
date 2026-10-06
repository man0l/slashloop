// SLA-550: every paid QA correction wave is its own durable debit, taken before the provider call,
// against the same experiment credit cap and wallet as the first wave, and refundable by its own receipt.
import { describe, test, expect } from 'bun:test';
import { step, type EngineDeps } from './engine.js';
import { TerminalFailure, SafeFailure, type ExecuteContext } from './providers.js';
import { ExperimentError, qaMaxAttempts, slideRequestAllowance, slideTaskRequestCap, SLIDE_FANOUT, type BriefData, type Experiment } from './schema.js';
import { serialize } from './store.js';
import { taskCost, applyRetry } from './service.js';
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
  const hooks: { beforeRefund?: () => void } = {};
  const deps: EngineDeps = {
    load: async () => structuredClone(row),
    save: async (e, charge = 0, ref, refunds = []) => {
      if (e.version !== row.version) return false;
      if (charge < 0 || refunds.length) hooks.beforeRefund?.();
      if (charge > 0 && row.creditsCharged + charge > e.maxCredits) throw new ExperimentError(409, 'experiment_budget_exceeded');
      if (charge > wallet) throw new InsufficientCreditsError('w', charge, wallet);
      // One atomic unit: the CAS row, the main movement and every extra refund land together (all validation is above).
      const refunded = refunds.reduce((n, r) => n + r.amount, 0);
      wallet += refunded; wallet -= charge;
      if (ref) ledger.set(ref, (ledger.get(ref) ?? 0) + charge);
      for (const r of refunds) ledger.set(r.ref, (ledger.get(r.ref) ?? 0) - r.amount);
      row = structuredClone({ ...e, version: e.version + 1, creditsCharged: row.creditsCharged + charge - refunded });
      Object.assign(e, row);
      return true;
    },
    prepare: async () => ({ units: FANOUT, execute }),
    now: () => 1000,
  };
  return { deps, hooks, get row() { return row; }, ledger, get net() { return [...ledger.values()].reduce((a, b) => a + b, 0); }, get task() { return row.tasks.find(t => t.id === 's0')!; } };
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

const CAP = slideTaskRequestCap(FANOUT);

describe('the authorized request allowance holds across engine attempts', () => {
  function threeSlides(h: ReturnType<typeof harness>) {
    h.row.instructions.variables = ['character', 'slides', 'visualStyle'];
    const original = h.row.variants[0]!.slides[0]!;
    h.row.variants[0]!.slides = [0, 1, 2].map(index => ({ ...original, index }));
    h.row.tasks.push(...[1, 2].map(index => ({ id: `s${index}`, kind: 'slide' as const, target: 'v1', index, status: 'pending' as const, attempts: 0, charged: 0 })));
  }

  test('engine retries that each admit corrections cannot exceed the advertised total (was 82 > 58)', async () => {
    let calls = 0;
    const h = harness(1000 * UNIT, async ctx => {
      calls++;
      await ctx!.admit(FANOUT); await ctx!.admit(FANOUT);
      const current = h.row.tasks.find(t => t.status === 'running')!;
      if (current.attempts < 3) throw new Error('socket lost');
      return done;
    });
    threeSlides(h);
    let clock = 1000;
    h.deps.now = () => clock;
    for (let i = 0; i < 9; i++) { await step('w', 'e', h.deps); clock += 1000000; }
    const budget = serialize(h.row).providerBudget;
    expect(budget.requestsStarted).toBeLessThanOrEqual(budget.maxRequests);
    for (const t of h.row.tasks.filter(t => t.kind === 'slide')) expect(t.requests ?? 0).toBeLessThanOrEqual(CAP);
    expect(h.row.status).toBe('paused');
    expect(h.row.error).toBe('request_allowance_exhausted');
    expect(h.row.creditsCharged).toBeLessThanOrEqual(h.row.maxCredits);
    expect(calls).toBeLessThanOrEqual(3 * 2);
  });

  test('a task at its allowance starts no provider call, even on its first wave of a new attempt', async () => {
    let calls = 0;
    const h = harness(1000 * UNIT, async () => { calls++; return done; });
    const t = h.row.tasks.find(t => t.id === 's0')!;
    Object.assign(t, { requests: CAP - FANOUT + 1, requestCap: CAP, attempts: 2, charged: 0 });
    await step('w', 'e', h.deps);
    expect(calls).toBe(0);
    expect(h.task.status).toBe('unknown');
    expect(h.task.error).toBe('request_allowance_exhausted');
    expect(h.task.requests).toBe(CAP - FANOUT + 1);
    expect(h.row.status).toBe('paused');
    expect(h.row.creditsCharged).toBe(0);
  });

  test('a correction that would pass the allowance is refused even when credit and the per-attempt ceiling allow it', async () => {
    const grants: boolean[] = [];
    const h = harness(1000 * UNIT, async ctx => { grants.push(await ctx!.admit(FANOUT)); return done; });
    Object.assign(h.row.tasks.find(t => t.id === 's0')!, { requests: CAP - FANOUT, requestCap: CAP, attempts: 1 });
    await step('w', 'e', h.deps);
    expect(grants).toEqual([false]);
    expect(h.task.requests).toBe(CAP);
  });

  test('the cap is frozen on first claim and never recomputed from a later environment', async () => {
    const h = harness(1000 * UNIT, async ctx => { await ctx!.admit(FANOUT); return done; });
    await step('w', 'e', h.deps);
    expect(h.task.requestCap).toBe(CAP);
    expect(serialize(h.row).providerBudget.maxRequests).toBeGreaterThanOrEqual(h.task.requestCap!);
  });

  test('an explicit retry of an exhausted slide authorizes exactly one more allowance; a paused pending task gets none', () => {
    const h = harness(1000 * UNIT, async () => done);
    const t = h.row.tasks.find(t => t.id === 's0')!;
    Object.assign(t, { requests: CAP, requestCap: CAP, status: 'unknown' });
    applyRetry(h.row, [t]);
    expect(t.requestCap).toBe(2 * CAP);
    expect(t.status).toBe('pending');
    applyRetry(h.row, [t]);
    expect(t.requestCap).toBe(2 * CAP);
  });
});

describe('known-failure refunds settle atomically with the terminal status', () => {
  const failing = async (ctx: ExecuteContext | undefined) => { await ctx!.admit(FANOUT); await ctx!.admit(FANOUT); throw new TerminalFailure('story_check_failed:x', 'failed', audit); };

  test('a transient settlement failure is retried and every receipt is refunded exactly once (was stranded)', async () => {
    const h = harness(100 * UNIT, failing);
    let blocked = 0;
    h.hooks.beforeRefund = () => { if (blocked++ === 0) throw new ExperimentError(503, 'refund_unavailable'); };
    await step('w', 'e', h.deps);
    expect(blocked).toBe(2);
    expect(h.row.status).toBe('failed');
    expect(h.task.status).toBe('failed');
    expect(h.task.corrections ?? []).toHaveLength(0);
    expect(h.net).toBe(0);
    expect(h.row.creditsCharged).toBe(0);
    await step('w', 'e', h.deps);
    expect(h.net).toBe(0);
  });

  test('an interruption that never recovers leaves nothing half-settled: no terminal status, every debit still owed', async () => {
    const h = harness(100 * UNIT, failing);
    h.hooks.beforeRefund = () => { throw new ExperimentError(503, 'refund_unavailable'); };
    await expect(step('w', 'e', h.deps)).rejects.toThrow('refund_unavailable');
    expect(h.row.status).toBe('generating');
    expect(h.task.status).toBe('running');
    expect(h.task.corrections).toHaveLength(2);
    expect(h.net).toBe(3 * FANOUT * UNIT);
  });

  test('losing the CAS to a concurrent writer re-reads and refunds once, never twice', async () => {
    const h = harness(100 * UNIT, failing);
    const save = h.deps.save;
    let raced = false;
    h.deps.save = async (e, charge = 0, ref, refunds) => {
      if (charge < 0 && !raced) { raced = true; const latest = structuredClone(h.row); latest.error = 'noise'; await save(latest); }
      return save(e, charge, ref, refunds);
    };
    await step('w', 'e', h.deps);
    expect(raced).toBe(true);
    expect(h.net).toBe(0);
    expect(h.row.status).toBe('failed');
    expect(h.task.corrections ?? []).toHaveLength(0);
    expect([...h.ledger.values()].every(v => v === 0)).toBe(true);
  });

  test('an unknown outcome keeps every debit and a retry does not re-refund them', async () => {
    const h = harness(100 * UNIT, async ctx => { await ctx!.admit(FANOUT); await ctx!.admit(FANOUT); throw new Error('socket lost'); });
    await step('w', 'e', h.deps);
    expect(h.task.status).toBe('pending');
    expect(h.task.corrections).toHaveLength(2);
    expect(h.net).toBe(3 * FANOUT * UNIT);
  });
});
