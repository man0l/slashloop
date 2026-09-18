import { describe, expect, test } from 'bun:test';
import { applyApprovedEstimate, MAX_EXPERIMENT_CREDITS } from './budget.js';
import { ExperimentError, type Experiment } from './schema.js';

function experiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 'e', workspaceId: 'w', status: 'review', version: 0, createdAt: '', updatedAt: '',
    instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 3, slideCount: 3, maxCredits: 210, creditsCharged: 6, report: null, inputs: [], variants: [],
    error: null, generationBasis: 'text-directed', assetPolicy: 'retained', tasks: [], commands: {}, allowPartial: false, createFingerprint: 'x',
    ...over,
  };
}

describe('applyApprovedEstimate', () => {
  test('allows generation paid from pack credits even when the auto-cap is short', () => {
    const e = experiment();
    applyApprovedEstimate(e, { totalCredits: 270, remainingCredits: 204, workspaceCredits: 500 });
    expect(e.maxCredits).toBe(276);
  });

  test('does not raise the cap when the estimate already fits', () => {
    const e = experiment({ maxCredits: 400, creditsCharged: 6 });
    applyApprovedEstimate(e, { totalCredits: 270, remainingCredits: 394, workspaceCredits: 500 });
    expect(e.maxCredits).toBe(400);
  });

  test('rejects when plan+pack cannot cover the estimate', () => {
    const e = experiment();
    expect(() => applyApprovedEstimate(e, { totalCredits: 270, remainingCredits: 204, workspaceCredits: 204 }))
      .toThrow(ExperimentError);
    expect(e.maxCredits).toBe(210);
  });

  test('rejects a raise past the schema ceiling', () => {
    const e = experiment({ maxCredits: MAX_EXPERIMENT_CREDITS, creditsCharged: 0 });
    expect(() => applyApprovedEstimate(e, { totalCredits: MAX_EXPERIMENT_CREDITS + 1, remainingCredits: MAX_EXPERIMENT_CREDITS, workspaceCredits: 99_999 }))
      .toThrow(/experiment_budget_exceeded/);
  });
});
