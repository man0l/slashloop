// SLA-896: resuming a budget-paused experiment must raise its cap to cover the named jobs, as generate/revise/feedback do, or the guard re-pauses it at once.
import { afterAll, describe, expect, mock, test } from 'bun:test';

const realCredits = { ...(await import('../lib/credits.js')) };
const realStore = { ...(await import('./store.js')) };
let saved: Experiment | null = null;
let row: Experiment;
mock.module('../lib/credits.js', () => ({ ...realCredits, creditBalance: async () => ({ total: 500 }) }));
mock.module('./store.js', () => ({ ...realStore, load: async () => structuredClone(row), save: async (e: Experiment) => { saved = structuredClone(e); return true; } }));
const { mutate } = await import('./service.js');
afterAll(() => { mock.module('../lib/credits.js', () => ({ ...realCredits })); mock.module('./store.js', () => ({ ...realStore })); });

import type { Experiment } from './schema.js';

const brief = { slides: [{ overlayText: '', scene: 's', composition: '', visibleChange: '' }] };
function paused(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 'e', workspaceId: 'w', status: 'paused', pipeline: 'contract', generationBasis: 'source-referenced', maxCredits: 152, creditsCharged: 144,
    error: 'experiment_budget_exceeded', report: null, commands: {}, revisions: [], instructions: { goal: 'g', variables: ['morph'] }, slideCount: 1,
    variants: [{ id: 'a', status: 'generating', brief, frozenBrief: brief, history: [], qaDeck: null, slides: [{ index: 0, status: 'pending', url: null, path: null, error: null, overlayText: '' }] }],
    tasks: [{ id: 't1', kind: 'slide', target: 'a', index: 0, status: 'pending', attempts: 0, charged: 0 }],
    ...over,
  } as unknown as Experiment;
}
const body = { workspaceId: 'w', idempotencyKey: 'retry-key-1', taskIds: ['t1'] };

describe('retry on a budget-paused experiment', () => {
  test('raises the cap to charged + the retry estimate, then resumes', async () => {
    row = paused(); saved = null;
    await mutate('w', 'e', 'retry', body);
    expect(saved!.status).toBe('generating');
    expect(saved!.maxCredits).toBeGreaterThan(152);
    expect(saved!.maxCredits).toBeGreaterThanOrEqual(saved!.creditsCharged + 10);
    expect(saved!.error).toBeNull();
  });

  test('does not touch the cap when the estimate already fits', async () => {
    row = paused({ maxCredits: 1000 }); saved = null;
    await mutate('w', 'e', 'retry', body);
    expect(saved!.maxCredits).toBe(1000);
  });

  test('refuses when the wallet cannot cover the retry, leaving nothing saved', async () => {
    row = paused({ workspaceId: 'w' }); saved = null;
    mock.module('../lib/credits.js', () => ({ ...realCredits, creditBalance: async () => ({ total: 1 }) }));
    await expect(mutate('w', 'e', 'retry', { ...body, idempotencyKey: 'retry-key-2' })).rejects.toMatchObject({ code: 'insufficient_budget' });
    expect(saved).toBeNull();
    mock.module('../lib/credits.js', () => ({ ...realCredits, creditBalance: async () => ({ total: 500 }) }));
  });
});
