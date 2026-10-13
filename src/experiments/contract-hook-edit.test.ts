// SLA-812: on the contract pipeline the hook IS slides[0].overlayText. Editing one arm's hook must not
// mirror its first-slide caption onto the sibling arm, and the two hook fields can never silently diverge.
import { describe, expect, test } from 'bun:test';
import { applyVariantEdit } from './service.js';
import type { BriefData, Experiment } from './schema.js';

const GLOW = "You won't believe the glow up";
const NOBODY = 'Nobody saw this glow up coming';
const BEDROOM = 'bedroom era. zero routine.';

const slides = (first: string, rest = ['', '', '', '', '']) => [
  { role: 'hook', scene: 'opener', overlayText: first, arcLevel: 'none' },
  ...rest.map((overlayText, i) => ({ role: 'beat', scene: `scene ${i + 2}`, overlayText, arcLevel: 'none' })),
] as BriefData['slides'];
const brief = (hook: string, over: Partial<BriefData> = {}): BriefData => ({
  concept: 'glow up', hook, character: '', visualStyle: 'photo', caption: '', cta: '', lockedConstraints: [], slides: slides(hook), ...over,
});
const variant = (id: string, b: BriefData, over: Record<string, unknown> = {}) => ({
  id, revision: 1, status: 'draft', title: id, hypothesis: 'h', changedVariables: [], brief: b,
  generationBasis: 'text-directed', history: [], slides: [], error: null, ...over,
});
function exp(variables: string[] = ['hook'], over: Record<string, unknown> = {}): Experiment {
  const alt = brief(NOBODY);
  return {
    id: 'e', workspaceId: 'w', status: 'review', slideCount: 6, tasks: [], pipeline: 'contract',
    instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables, mode: 'controlled' },
    variants: [variant('base', brief(GLOW)), variant('alt', alt, { changedVariables: [{ name: 'hook', value: NOBODY }] })],
    ...over,
  } as unknown as Experiment;
}
const edit = (b: BriefData, over: Record<string, unknown> = {}) => ({ workspaceId: 'w', revision: 1, brief: b, ...over });
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return `${e.statusCode}:${e.code}`; } return 'ok'; };
const [BASE, ALT] = [0, 1];
const consistent = (e: Experiment) => e.variants.forEach(v => expect(v.brief.hook).toBe(v.brief.slides[0]!.overlayText || 'No caption'));

describe('contract pipeline: hook edits stay on their own arm', () => {
  test('editing the alternate hook leaves the baseline hook, caption and revision alone', () => {
    const e = exp();
    applyVariantEdit(e, 'alt', edit(brief(BEDROOM), { title: 'bedroom' }));
    expect(e.variants[ALT]!.brief.hook).toBe(BEDROOM);
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe(BEDROOM);
    expect(e.variants[ALT]!.revision).toBe(2);
    expect(e.variants[BASE]!.brief.hook).toBe(GLOW);
    expect(e.variants[BASE]!.brief.slides[0]!.overlayText).toBe(GLOW);
    expect(e.variants[BASE]!.revision).toBe(1);
    expect(e.variants[BASE]!.history).toHaveLength(0);
    consistent(e);
  });

  test('editing the baseline hook leaves the alternate alone', () => {
    const e = exp();
    applyVariantEdit(e, 'base', edit(brief("Wait for it, it's different")));
    expect(e.variants[BASE]!.brief.slides[0]!.overlayText).toBe("Wait for it, it's different");
    expect(e.variants[ALT]!.brief.hook).toBe(NOBODY);
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe(NOBODY);
    expect(e.variants[ALT]!.revision).toBe(1);
    consistent(e);
  });

  test('supporting slides stay shared: other slides mirror, each arm keeps its own first caption', () => {
    const e = exp();
    const sent = brief(BEDROOM, { slides: slides(BEDROOM, ['two', 'three', '', '', '']).map((s, i) => i === 2 ? { ...s, scene: 'new third scene' } : s) });
    applyVariantEdit(e, 'alt', edit(sent));
    const base = e.variants[BASE]!;
    expect(base.revision).toBe(2);
    expect(base.brief.slides.map(s => s.overlayText)).toEqual([GLOW, 'two', 'three', '', '', '']);
    expect(base.brief.slides[2]!.scene).toBe('new third scene');
    expect(base.brief.hook).toBe(GLOW);
    expect(e.variants[ALT]!.brief.slides.map(s => s.overlayText)).toEqual([BEDROOM, 'two', 'three', '', '', '']);
    consistent(e);
  });

  test('a hook-only change in the first slide scene still mirrors to the sibling', () => {
    const e = exp();
    const sent = brief(BEDROOM, { slides: slides(BEDROOM).map((s, i) => i === 0 ? { ...s, scene: 'new opener' } : s) });
    applyVariantEdit(e, 'alt', edit(sent));
    expect(e.variants[BASE]!.brief.slides[0]).toMatchObject({ scene: 'new opener', overlayText: GLOW });
  });

  test('stored contract fields merged back into the edit do not read as a change to the sibling', () => {
    const e = exp();
    const rich = (first: string) => slides(first).map((s, i) => ({ role: s.role, scene: s.scene, overlayText: s.overlayText, composition: `c${i}`, visibleChange: `v${i}`, arcLevel: s.arcLevel })) as BriefData['slides'];
    e.variants[BASE]!.brief = brief(GLOW, { slides: rich(GLOW) });
    e.variants[ALT]!.brief = brief(NOBODY, { slides: rich(NOBODY) });
    const sent = slides(BEDROOM).map(({ role, scene, overlayText }) => ({ role, scene, overlayText })) as BriefData['slides'];
    applyVariantEdit(e, 'alt', edit(brief(BEDROOM, { slides: sent })));
    expect(e.variants[BASE]!.revision).toBe(1);
    expect(e.variants[BASE]!.brief.slides[0]!.overlayText).toBe(GLOW);
    expect(e.variants[ALT]!.brief.slides[1]!.composition).toBe('c1');
  });

  test('the recovered production state is repaired by one baseline edit that keeps the alternate', () => {
    const e = exp();
    // State after the bug: baseline brief.hook glow-up but its first caption is the bedroom copy; both at revision 2.
    e.variants[BASE] = variant('base', brief(GLOW, { slides: slides(BEDROOM) }), { revision: 2 }) as never;
    e.variants[ALT] = variant('alt', brief(BEDROOM), { revision: 2, changedVariables: [{ name: 'hook', value: BEDROOM }] }) as never;
    applyVariantEdit(e, 'base', edit(brief(GLOW), { revision: 2 }));
    expect(e.variants[BASE]!.revision).toBe(3);
    expect(e.variants[BASE]!.brief.hook).toBe(GLOW);
    expect(e.variants[BASE]!.brief.slides[0]!.overlayText).toBe(GLOW);
    expect(e.variants[ALT]!.revision).toBe(2);
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe(BEDROOM);
    consistent(e);
  });
});

describe('contract pipeline: hook and first-slide caption cannot diverge', () => {
  test('changing only brief.hook rewrites the first-slide caption', () => {
    const e = exp();
    applyVariantEdit(e, 'alt', edit(brief(NOBODY, { hook: BEDROOM })));
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe(BEDROOM);
    expect(e.variants[BASE]!.brief.slides[0]!.overlayText).toBe(GLOW);
    consistent(e);
  });

  test('blanking the first-slide caption stores the placeholder hook instead of a stale one', () => {
    const e = exp();
    applyVariantEdit(e, 'alt', edit(brief(NOBODY, { slides: slides('') })));
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe('');
    expect(e.variants[ALT]!.brief.hook).toBe('No caption');
    expect(e.variants[BASE]!.brief.hook).toBe(GLOW);
    consistent(e);
  });

  test('setting the hook to the placeholder blanks the caption', () => {
    const e = exp();
    applyVariantEdit(e, 'alt', edit(brief('No caption', { slides: slides(NOBODY) })));
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe('');
    consistent(e);
  });

  test('changing both to different texts is refused, mutating nothing', () => {
    const e = exp();
    expect(code(() => applyVariantEdit(e, 'alt', edit(brief(BEDROOM, { slides: slides('something else') }))))).toBe('422:hook_overlay_conflict');
    expect(e.variants[ALT]!.revision).toBe(1);
    expect(e.variants[ALT]!.brief.hook).toBe(NOBODY);
  });

  test('a title-only edit does not touch the siblings or rewrite stored copy', () => {
    const e = exp();
    applyVariantEdit(e, 'alt', edit(brief(NOBODY), { title: 'renamed' }));
    expect(e.variants[ALT]!.title).toBe('renamed');
    expect(e.variants[BASE]!.revision).toBe(1);
  });

  test('hook not chosen as a variable: the single hook text is shared by both arms', () => {
    const e = exp(['cta']);
    e.variants[ALT] = variant('alt', brief(GLOW, { cta: 'Buy' }), { changedVariables: [{ name: 'cta', value: 'Buy' }] }) as never;
    applyVariantEdit(e, 'base', edit(brief(BEDROOM)));
    for (const v of e.variants) {
      expect(v.brief.hook).toBe(BEDROOM);
      expect(v.brief.slides[0]!.overlayText).toBe(BEDROOM);
    }
    expect(e.variants[ALT]!.brief.cta).toBe('Buy');
  });
});

describe('legacy pipeline is unchanged', () => {
  test('hook and first-slide caption are not coupled and shared slides still mirror whole', () => {
    const e = exp(['hook'], { pipeline: null });
    applyVariantEdit(e, 'alt', edit(brief(BEDROOM, { slides: slides('legacy caption') })));
    expect(e.variants[ALT]!.brief.hook).toBe(BEDROOM);
    expect(e.variants[ALT]!.brief.slides[0]!.overlayText).toBe('legacy caption');
  });
});
