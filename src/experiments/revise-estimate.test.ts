// SLA-811: pricing a QA-driven brief revision. The wallet is faked so the arithmetic is asserted without a database.
import { afterAll, describe, expect, mock, test } from 'bun:test';

const realCredits = { ...(await import('../lib/credits.js')) };
mock.module('../lib/credits.js', () => ({ ...realCredits, creditBalance: async () => ({ total: 500 }) }));
const { estimate, estimateRevise } = await import('./service.js');
afterAll(() => { mock.module('../lib/credits.js', () => ({ ...realCredits })); });

import { CREDIT_COSTS } from '../lib/credits.js';
import type { Experiment } from './schema.js';

const slides = (n: number, status = 'done') => Array.from({ length: n }, (_, index) => ({ index, status, url: 'u', path: 'p', error: null, overlayText: '' }));
const brief = (n: number) => ({ slides: Array.from({ length: n }, () => ({ overlayText: '', scene: 's', composition: '', visibleChange: '' })) });
function failedExperiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 'e', workspaceId: 'w', status: 'failed', pipeline: 'contract', generationBasis: 'source-referenced', maxCredits: 1000, creditsCharged: 40, revisions: [],
    instructions: { goal: 'g', variables: ['hook'] }, slideCount: 3, tasks: [],
    variants: [
      { id: 'a', status: 'failed', brief: brief(3), frozenBrief: brief(3), slides: slides(3), history: [], qaDeck: { verdict: 'failed', failures: { 1: ['caption'] } } },
      { id: 'b', status: 'generating', brief: brief(3), frozenBrief: brief(3), slides: slides(3, 'pending'), history: [], qaDeck: null },
    ],
    ...over,
  } as unknown as Experiment;
}

describe('estimateRevise', () => {
  test('charges one planning call plus a render and QA of every arm, and prices the repair round as headroom', async () => {
    const e = failedExperiment();
    const est = await estimateRevise(e);
    expect(est.planningCredits).toBe(CREDIT_COSTS.experimentPlanningCall);
    expect(est.generationCredits).toBeGreaterThan(0);
    expect(est.totalCredits).toBe(est.planningCredits + est.generationCredits);
    expect(est.maxTotalCredits).toBe(est.totalCredits + est.correctionCredits);
    expect(est.workspaceCredits).toBe(500);
    expect(await estimate(e, 'revise')).toEqual(est);
  });

  test('refuses what applyRevise would refuse, and a scoped revise', async () => {
    await expect(estimateRevise(failedExperiment({ status: 'completed' }))).rejects.toMatchObject({ code: 'not_revisable' });
    await expect(estimate(failedExperiment(), 'revise', ['a'])).rejects.toMatchObject({ code: 'revise_takes_no_scope' });
    await expect(estimateRevise(failedExperiment({ revisions: [{}, {}] as never }))).rejects.toMatchObject({ code: 'revise_limit' });
  });
});
