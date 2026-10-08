// SLA-686: rewriting the content of a review-state experiment must not hit a
// 422 unapproved_variable that no single-variant edit can ever clear.
import { describe, expect, test } from 'bun:test';
import { applyVariantEdit } from './service.js';
import type { BriefData, Experiment } from './schema.js';

const slides = (topic: string) => [
  { role: 'hook', scene: `${topic} opener`, overlayText: `${topic} hook` },
  { role: 'body', scene: `${topic} detail`, overlayText: `${topic} body` },
  { role: 'end', scene: `${topic} close`, overlayText: '' },
];
const food: BriefData = { concept: 'food ranking', hook: 'Sub 5 vs chad', character: 'a chef', visualStyle: 'photo', caption: 'food', cta: 'Follow for food', lockedConstraints: [], slides: slides('food') };
const variant = (id: string, brief: BriefData, over: Record<string, unknown> = {}) => ({
  id, revision: 3, status: 'draft', title: 'foodmaxxing', hypothesis: 'h', changedVariables: [], brief,
  generationBasis: 'text-directed', history: [], slides: [], error: null, ...over,
});
function exp(variables: string[], over: Record<string, unknown> = {}): Experiment {
  const alt = { ...food, hook: 'Sub 3 vs chad' };
  return {
    id: 'e', workspaceId: 'w', status: 'review', slideCount: 3, tasks: [],
    instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables, mode: 'controlled' },
    variants: [variant('base', food), variant('alt', alt, { changedVariables: [{ name: 'hook', value: alt.hook }] })],
    ...over,
  } as unknown as Experiment;
}
const faceless: BriefData = { ...food, concept: 'faceless maxxing', character: 'no face', caption: 'faceless', cta: 'Follow for faceless', slides: slides('faceless') };
const edit = (brief: BriefData, over: Record<string, unknown> = {}) => ({ workspaceId: 'w', revision: 3, brief, ...over });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return `${e.statusCode}:${e.code}`; } return 'ok'; };

describe('update_experiment_variant shared fields', () => {
  test('retheming the baseline carries the unapproved fields to the alternate', () => {
    const e = exp(['hook']);
    applyVariantEdit(e, 'base', edit({ ...faceless, hook: 'Sub 5 vs chad' }, { title: 'facelessmaxxing' }));
    const [base, alt] = e.variants;
    expect(base!.title).toBe('facelessmaxxing');
    expect(base!.revision).toBe(4);
    expect(alt!.brief.concept).toBe('faceless maxxing');
    expect(alt!.brief.slides).toEqual(faceless.slides);
    expect(alt!.brief.cta).toBe('Follow for faceless');
    expect(alt!.brief.hook).toBe('Sub 3 vs chad');
    expect(alt!.revision).toBe(4);
    expect(alt!.history).toHaveLength(1);
    expect(alt!.history[0]!.brief.concept).toBe('food ranking');
    expect(alt!.changedVariables.map(c => c.name)).toEqual(['hook']);
  });

  test('editing the alternate carries shared fields back to the baseline', () => {
    const e = exp(['hook']);
    applyVariantEdit(e, 'alt', edit({ ...faceless, hook: 'Sub 3 vs chad' }));
    expect(e.variants[0]!.brief.caption).toBe('faceless');
    expect(e.variants[0]!.brief.hook).toBe('Sub 5 vs chad');
  });

  test('a chosen variable is edited per variant and does not spread', () => {
    const e = exp(['hook']);
    applyVariantEdit(e, 'alt', edit({ ...food, hook: 'Sub 1 vs chad' }, { revision: 3 }));
    expect(e.variants[0]!.brief.hook).toBe('Sub 5 vs chad');
    expect(e.variants[0]!.revision).toBe(3);
    expect(e.variants[1]!.brief.hook).toBe('Sub 1 vs chad');
  });

  test('title alone renames without touching the brief or siblings', () => {
    const e = exp(['hook']);
    applyVariantEdit(e, 'base', edit(food, { title: 'new title' }));
    expect(e.variants[0]!.title).toBe('new title');
    expect(e.variants[1]!.revision).toBe(3);
  });

  test('concept as a variable: slides stay per-variant, other shared fields still spread', () => {
    const e = exp(['concept']);
    e.variants[1]!.brief = { ...food, concept: 'other angle', slides: slides('angle') };
    applyVariantEdit(e, 'base', edit({ ...food, cta: 'New CTA', slides: slides('rewritten') }));
    expect(e.variants[1]!.brief.cta).toBe('New CTA');
    expect(e.variants[1]!.brief.slides).toEqual(slides('angle'));
  });

  test('a frozen sibling cannot be rewritten, so the edit is refused with the fields named', () => {
    const e = exp(['hook']);
    e.variants[1] = variant('alt', { ...food, hook: 'Sub 3 vs chad' }, { status: 'generating', frozenBrief: food }) as never;
    let err: any;
    try { applyVariantEdit(e, 'base', edit(faceless)); } catch (x) { err = x; }
    expect(`${err.statusCode}:${err.code}`).toBe('422:unapproved_variable');
    expect(err.message).toContain('concept');
    expect(err.message).toContain('Only hook may differ');
    expect(e.variants[0]!.revision).toBe(3);
  });

  test('making the variants identical in the chosen variable says so', () => {
    const e = exp(['hook']);
    let err: any;
    try { applyVariantEdit(e, 'alt', edit({ ...food })); } catch (x) { err = x; }
    expect(err.code).toBe('unapproved_variable');
    expect(err.message).toContain('identical to the baseline');
  });

  test('stale revision and non-editable states are still refused', () => {
    expect(code(() => applyVariantEdit(exp(['hook']), 'base', edit(food, { revision: 1 })))).toBe('409:revision_conflict');
    expect(code(() => applyVariantEdit(exp(['hook'], { status: 'generating' }), 'base', edit(food)))).toBe('409:experiment_active');
  });
});
