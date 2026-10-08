// SLA-532: which lifecycle states may rewrite a variant brief. The guard is
// pure, so the matrix is asserted without a store, provider or credit.
import { describe, expect, test } from 'bun:test';
import { assertVariantEditable } from './service.js';
import type { BriefData, Experiment } from './schema.js';

const brief: BriefData = {
  concept: 'c', hook: 'h', character: 'a', visualStyle: 'v', caption: '', cta: '', lockedConstraints: [],
  slides: [{ role: 'hook', scene: 's', overlayText: '' }],
};
const variant = (id: string, over: Record<string, unknown> = {}) => ({
  id, revision: 2, status: 'draft', title: id, hypothesis: 'h', changedVariables: [], brief,
  generationBasis: 'text-directed', history: [], slides: [], error: null, ...over,
});
function exp(status: string, over: Record<string, unknown> = {}): Experiment {
  return { id: 'e', workspaceId: 'w', status, variants: [variant('v1'), variant('v2')], tasks: [], ...over } as unknown as Experiment;
}
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return `${e.statusCode}:${e.code}`; } return 'ok'; };
const edit = (e: Experiment, id: string | undefined = 'v1', rev = 2) => code(() => assertVariantEditable(e, id, rev));
const task = (status: string, over: Record<string, unknown> = {}) => ({ id: 't', kind: 'slide', target: 'v1', index: 0, status, attempts: 1, charged: 0, ...over });

describe('update_experiment_variant edit matrix', () => {
  test('review and completed allow a draft variant', () => {
    expect(edit(exp('review'))).toBe('ok');
    expect(edit(exp('completed', { variants: [variant('v1'), variant('v2', { status: 'done', frozenBrief: brief })] }))).toBe('ok');
  });

  test('completed refuses a rendered or frozen variant', () => {
    const e = exp('completed', { variants: [variant('v1', { status: 'done', frozenBrief: brief }), variant('v2')] });
    expect(edit(e, 'v1')).toBe('409:variant_frozen');
    expect(edit(e, 'v2')).toBe('ok');
  });

  test('a frozen brief on a draft-status variant is refused', () => {
    expect(edit(exp('review', { variants: [variant('v1', { frozenBrief: brief })] }))).toBe('409:variant_frozen');
  });

  test('a stale revision is refused, not overwritten', () => {
    expect(edit(exp('review'), 'v1', 1)).toBe('409:revision_conflict');
    expect(edit(exp('failed'), 'v1', 3)).toBe('409:revision_conflict');
  });

  test('planning and generating are always refused, even for a draft variant', () => {
    expect(edit(exp('planning'))).toBe('409:experiment_active');
    expect(edit(exp('generating'))).toBe('409:experiment_active');
  });

  test('cancelled is always refused', () => {
    expect(edit(exp('cancelled'))).toBe('409:experiment_cancelled');
  });

  test('a pre-plan draft experiment is not editable', () => {
    expect(edit(exp('draft', { variants: [] }))).toBe('409:not_editable');
  });

  test('an unknown variant is variant_not_found; a missing id is variant_required', () => {
    expect(edit(exp('review'), 'nope')).toBe('404:variant_not_found');
    expect(code(() => assertVariantEditable(exp('review'), undefined, 2))).toBe('400:variant_required');
  });

  for (const status of ['failed', 'paused']) {
    describe(status, () => {
      test('allows a draft variant with no live work', () => {
        expect(edit(exp(status))).toBe('ok');
        expect(edit(exp(status, { tasks: [task('failed'), task('done'), task('pending')] }))).toBe('ok');
      });
      test('refuses while a job for the variant is running or unknown', () => {
        expect(edit(exp(status, { tasks: [task('running')] }))).toBe('409:variant_in_flight');
        expect(edit(exp(status, { tasks: [task('unknown')] }))).toBe('409:variant_in_flight');
      });
      test('a non-slide (planning) job in flight blocks every variant', () => {
        expect(edit(exp(status, { tasks: [task('running', { kind: 'briefs', target: undefined })] }))).toBe('409:variant_in_flight');
      });
      test('a sibling variant job in flight does not block this draft variant', () => {
        expect(edit(exp(status, { tasks: [task('running', { target: 'v2' })] }))).toBe('ok');
      });
      test('refuses a frozen variant even when no job is live', () => {
        expect(edit(exp(status, { variants: [variant('v1', { status: 'failed', frozenBrief: brief })] }))).toBe('409:variant_frozen');
      });
    });
  }
});
