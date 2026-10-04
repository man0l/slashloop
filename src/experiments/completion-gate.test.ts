// SLA-430 D8 at the engine boundary: a verified QA failure or an unverifiable
// check must never requeue into a pass, never settle a deliverable, and never
// transition the slide, the variant or the experiment to a completed state.
import { describe, test, expect } from 'bun:test';
import { step, type EngineDeps } from './engine.js';
import { TerminalFailure } from './providers.js';
import { ExperimentError, type BriefData, type Experiment } from './schema.js';

const instructions = { goal: 'Sell tea', brand: 'Tea', audience: 'Adults', language: 'English', direction: 'Calm', lockedConstraints: [], variables: ['hook' as const], mode: 'controlled' as const };
const brief: BriefData = { concept: 'Tea routine', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: 'Tea time', cta: '', lockedConstraints: [], slides: Array.from({ length: 3 }, (_, i) => ({ role: i ? 'body' : 'hook', scene: 'Tea cup', overlayText: '' })) };

function slideFixture(): Experiment {
  const v = { id: 'v1', revision: 1, status: 'generating', baselineId: null, generationBasis: 'text-directed' as const, history: [], title: 'B', hypothesis: 'h', changedVariables: [], brief, frozenBrief: brief, slides: [{ index: 0, status: 'pending', url: null, path: null, error: null, overlayText: '' }], error: null };
  return { id: 'e', workspaceId: 'w', status: 'generating', version: 0, createdAt: '', updatedAt: '', instructions, variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 0, report: null, inputs: [], variants: [v], error: null, generationBasis: 'text-directed', assetPolicy: 'retained', tasks: [{ id: 'b', kind: 'briefs', status: 'done', attempts: 1, charged: 0 }, { id: 's0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 0 }], commands: {}, allowPartial: false, createFingerprint: 'x' };
}
function harness(row: Experiment, prepare: EngineDeps['prepare']) {
  let current = row; let charges = 0;
  const deps: EngineDeps = {
    load: async () => structuredClone(current),
    save: async (e, charge = 0) => { if (e.version !== current.version) return false; current = structuredClone({ ...e, version: e.version + 1, creditsCharged: e.creditsCharged + charge }); charges += charge; Object.assign(e, current); return true; },
    prepare, now: () => 1000,
  };
  return { deps, get row() { return current; }, get charges() { return charges; }, get slideTask() { return current.tasks.find(t => t.id === 's0')!; } };
}
const audit = { verdict: 'fail', contractHash: 'abc123', corrected: true, attempts: 2, reasons: ['gaze is looking left not right'], checks: [{ check: 'the subject\'s gaze is unchanged: "looking right"', status: 'fail' as const, reason: 'looking left' }], prompt: 'p' };
const okResult = { path: 'p/0.jpg', url: 'https://thumbs.test/p/0.jpg', model: 'm', provider: 'openrouter', costUsd: 0, prompt: 'p', reference: null, fanout: { requested: 1, rendered: 1, chosen: 0, judge: [] }, story: { ...audit, verdict: 'pass' as const, reasons: [] } };

describe('completion gate', () => {
  test('a verified QA pass settles the slide and can complete the experiment', async () => {
    const h = harness(slideFixture(), async () => ({ execute: async () => okResult }));
    await step('w', 'e', h.deps);
    expect(h.slideTask?.status).toBe('done');
    expect(h.row.variants[0]?.slides[0]).toMatchObject({ status: 'done', url: 'https://thumbs.test/p/0.jpg' });
    expect(h.row.status).toBe('completed');
    expect(h.row.variants[0]?.status).toBe('done');
  });

  test('a verified QA failure never completes the slide, variant or experiment', async () => {
    const h = harness(slideFixture(), async () => ({ execute: async () => { throw new TerminalFailure('story_check_failed:gaze is looking left not right', 'failed', audit); } }));
    await step('w', 'e', h.deps);
    expect(h.row.status).toBe('failed');
    expect(h.row.status).not.toBe('completed');
    expect(h.row.variants[0]?.status).toBe('failed');
    expect(h.row.variants[0]?.slides[0]).toMatchObject({ status: 'failed', url: null, path: null });
    expect(h.slideTask).toMatchObject({ status: 'failed', error: 'provider_result_rejected:story_check_failed:gaze is looking left not right' });
    // The QA record survives the failure, including the residual lock violation.
    expect(h.row.variants[0]?.slides[0]?.qa).toMatchObject({ verdict: 'fail', contractHash: 'abc123', attempts: 2 });
    expect(h.row.variants[0]?.slides[0]?.qa?.checks[0]?.reason).toBe('looking left');
  });

  test('a QA failure is terminal: no self-heal retry, and the charge is refunded', async () => {
    let calls = 0;
    const h = harness(slideFixture(), async () => ({ execute: async () => { calls++; throw new TerminalFailure('story_check_failed:overlay cropped', 'failed', audit); } }));
    for (let i = 0; i < 5; i++) await step('w', 'e', h.deps);
    expect(calls).toBe(1); // never requeued into a second paid attempt
    expect(h.slideTask?.attempts).toBe(1);
    expect(h.slideTask?.status).toBe('failed');
    expect(h.charges).toBe(0);
    expect(h.slideTask?.charged).toBe(0);
    expect(h.row.creditsCharged).toBe(0);
  });

  test('an unverifiable check routes to review, never to completion', async () => {
    const h = harness(slideFixture(), async () => ({ execute: async () => { throw new TerminalFailure('story_unverified:qa_missing_checks', 'unverified', { ...audit, verdict: 'error' }); } }));
    await step('w', 'e', h.deps);
    expect(h.row.status).toBe('paused');
    expect(h.row.status).not.toBe('completed');
    expect(h.row.variants[0]?.status).toBe('paused');
    expect(h.row.variants[0]?.slides[0]?.status).toBe('unknown');
    expect(h.slideTask?.status).toBe('unknown');
    expect(h.slideTask?.error).toContain('story_unverified');
    expect(h.row.variants[0]?.slides[0]?.qa).toMatchObject({ verdict: 'error' });
  });

  test('a contradictory preparation issue fails fast with its precise code', async () => {
    let calls = 0;
    const h = harness(slideFixture(), async () => { calls++; throw new ExperimentError(422, 'unresolved_casting_target', 'no concrete visible attribute'); });
    await step('w', 'e', h.deps);
    expect(calls).toBe(1);
    expect(h.slideTask?.status).toBe('failed');
    expect(h.slideTask?.error).toBe('unresolved_casting_target');
    expect(h.row.status).toBe('failed');
  });

  test('an unknown source copy state stops preparation instead of guessing', async () => {
    let calls = 0;
    const h = harness(slideFixture(), async () => { calls++; throw new ExperimentError(422, 'unknown_source_copy', 'no usable extraction'); });
    await step('w', 'e', h.deps);
    expect(calls).toBe(1);
    expect(h.slideTask?.error).toBe('unknown_source_copy');
    expect(h.charges).toBe(0);
  });
});
