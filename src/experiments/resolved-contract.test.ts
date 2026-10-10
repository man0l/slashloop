import { describe, expect, test } from 'bun:test';
import {
  ContractError, buildArmB, captionEditPrompt, chooseReferenceUse, compileQaPrompt, compileSlidePrompt, diffArms, normalizeContract,
  pickFramesByArc, qaVerdict, repairSlides, slideRole, slideWork, tagLocks, assertArmsDifferOnly,
  type ArmBrief, type ContractInput, type ResolvedContract,
} from './resolved-contract.js';
import { universalLocks } from './source-format.js';

const slide = (o: Partial<{ overlayText: string; arcLevel: string; scene: string; composition: string; visibleChange: string }> = {}) =>
  ({ overlayText: '', arcLevel: 'none', scene: 'a scene', composition: 'centred', visibleChange: '', ...o });

const input = (o: Partial<ContractInput> = {}): ContractInput => ({
  direction: 'dir', slideCount: 3, frameCount: 3, variable: 'hook',
  locks: tagLocks(['Faceless: no face visible', ...universalLocks()], universalLocks()),
  sourceDefaults: ['2x2 food grid', 'Keep the subject exactly as in the source frame', 'styleFormula.medium = collage'],
  ...o,
});

const raw = (o: Record<string, unknown> = {}) => ({
  droppedSourceDefaults: [], droppedLocks: [], subject: 'objects', identity: 'none', identitySheet: '', medium: 'pencil line art',
  keepSourceImage: false, borrowSourceLook: false, arcAxis: '',
  sourceFrameLevels: [{ index: 0, level: 'none', showsPerson: false }, { index: 1, level: 'none', showsPerson: false }, { index: 2, level: 'none', showsPerson: false }],
  slides: [slide({ overlayText: 'Hook A' }), slide({ overlayText: 'two' }), slide({ overlayText: 'three' })],
  variantB: { variable: 'hook', value: 'Hook B', slides: [] },
  ...o,
});

describe('lock tagging and precedence', () => {
  test('caller locks are user, always-on locks are workspace', () => {
    const locks = tagLocks(['Faceless: no face visible', ...universalLocks()], universalLocks());
    expect(locks.filter(l => l.origin === 'user').map(l => l.text)).toEqual(['Faceless: no face visible']);
    expect(locks.filter(l => l.origin === 'workspace')).toHaveLength(4);
  });

  test('source defaults are dropped with a reason; unlisted ones are kept', () => {
    const c = normalizeContract(raw({ droppedSourceDefaults: [{ default: '2x2 food grid', reason: 'direction asks for fresh imagery' }, { default: 'not an input default', reason: 'x' }] }), input());
    expect(c.droppedSourceDefaults).toEqual([{ default: '2x2 food grid', reason: 'direction asks for fresh imagery' }]);
    expect(c.keptSourceDefaults).toEqual(['Keep the subject exactly as in the source frame', 'styleFormula.medium = collage']);
  });

  test('a source default dropped without a reason is kept', () => {
    const c = normalizeContract(raw({ droppedSourceDefaults: [{ default: '2x2 food grid', reason: '  ' }] }), input());
    expect(c.droppedSourceDefaults).toEqual([]);
    expect(c.keptSourceDefaults).toContain('2x2 food grid');
  });

  test('a workspace lock is dropped only with a reason; a user lock is never dropped', () => {
    const real = universalLocks()[2]!;
    const c = normalizeContract(raw({ droppedLocks: [
      { lock: real, origin: 'workspace', reason: 'the user keeps the real source person' },
      { lock: universalLocks()[3]!, origin: 'workspace', reason: '' },
      { lock: 'Faceless: no face visible', origin: 'user', reason: 'because' },
    ] }), input());
    expect(c.droppedLocks).toEqual([{ lock: real, origin: 'workspace', reason: 'the user keeps the real source person' }]);
    const hard = c.hardLocks.map(l => l.text);
    expect(hard).toContain('Faceless: no face visible');
    expect(hard).toContain(universalLocks()[3]);
    expect(hard).not.toContain(real);
    expect(c.issues.length).toBe(2);
  });

  test('source defaults never appear as hard rules, and a dropped lock leaves the prompt', () => {
    const real = universalLocks()[2]!;
    const c = normalizeContract(raw({ droppedLocks: [{ lock: real, origin: 'workspace', reason: 'user keeps a real person' }] }), input());
    const p = compileSlidePrompt(c, 0, 'fresh', 'none');
    expect(p).toContain('HARD RULES');
    expect(p).not.toContain(real);
    expect(p).toContain('PREFERENCES');
    expect(p.split('PREFERENCES')[0]).not.toContain('2x2 food grid');
    expect(p).not.toMatch(/USER LOCKS/i);
  });

  test('empty arcAxis forces every arcLevel to none', () => {
    const c = normalizeContract(raw({ slides: [slide({ arcLevel: 'low' }), slide({ arcLevel: 'mid' }), slide({ arcLevel: 'high' })] }), input());
    expect(c.slides.map(s => s.arcLevel)).toEqual(['none', 'none', 'none']);
  });

  test('keeping the source images forces the source identity', () => {
    const c = normalizeContract(raw({ keepSourceImage: true, identity: 'invented-consistent', identitySheet: 'a man' }), input());
    expect(c.identity).toBe('source');
    expect(c.identitySheet).toBe('');
  });

  test('a short slide list or a missing identity sheet is rejected', () => {
    expect(() => normalizeContract(raw({ slides: [slide()] }), input())).toThrow(ContractError);
    expect(() => normalizeContract(raw({ identity: 'invented-consistent', identitySheet: ' ' }), input())).toThrow(ContractError);
  });
});

describe('referenceUse is chosen by code', () => {
  const base = { keepSourceImage: false, borrowSourceLook: false, identity: 'none' as const, sourceFrames: [{ index: 0, level: 'none' as const, showsPerson: true }] };
  test('edit only when the source image is kept', () => {
    expect(chooseReferenceUse({ ...base, keepSourceImage: true })).toBe('edit');
    expect(chooseReferenceUse({ ...base, borrowSourceLook: true })).toBe('style-only');
    expect(chooseReferenceUse(base)).toBe('none');
  });
  test('invented identity blocks a style reference when a source frame shows a person', () => {
    expect(chooseReferenceUse({ ...base, borrowSourceLook: true, identity: 'invented-consistent' })).toBe('none');
    expect(chooseReferenceUse({ ...base, borrowSourceLook: true, identity: 'invented-per-slide' })).toBe('none');
  });
  test('invented identity may borrow the look when no source frame shows a person', () => {
    const frames = [{ index: 0, level: 'none' as const, showsPerson: false }];
    expect(chooseReferenceUse({ ...base, borrowSourceLook: true, identity: 'invented-consistent', sourceFrames: frames })).toBe('style-only');
  });
  test('an unknown frame counts as showing a person', () => {
    const c = normalizeContract(raw({ borrowSourceLook: true, identity: 'invented-consistent', identitySheet: 'x', sourceFrameLevels: [] }), input());
    expect(c.sourceFrames.every(f => f.showsPerson)).toBe(true);
    expect(chooseReferenceUse(c)).toBe('none');
  });
});

describe('frames are picked by arc level, never by position', () => {
  const frames = [
    { index: 0, level: 'high' as const, showsPerson: true }, { index: 1, level: 'low' as const, showsPerson: true },
    { index: 2, level: 'mid' as const, showsPerson: true }, { index: 3, level: 'low' as const, showsPerson: true },
  ];
  const deck = (arcs: Array<'low' | 'mid' | 'high' | 'none'>, over = {}) => ({
    keepSourceImage: true, borrowSourceLook: false, identity: 'source' as const, arcAxis: 'week 1 to week 4', sourceFrames: frames,
    slides: arcs.map(a => slide({ arcLevel: a }) as ReturnType<typeof slide> & { arcLevel: 'low' | 'mid' | 'high' | 'none' }), ...over,
  });
  test('the slide order follows arcLevel, not source order', () => {
    const picks = pickFramesByArc(deck(['low', 'mid', 'high']) as never);
    expect(picks.map(p => p.frameIndex)).toEqual([1, 2, 0]);
    expect(picks.every(p => p.referenceUse === 'edit')).toBe(true);
  });
  test('a frame is never reused and a missing level yields a new slide, not the last frame', () => {
    const picks = pickFramesByArc(deck(['low', 'low', 'low']) as never);
    expect(picks.map(p => p.frameIndex)).toEqual([1, 3, null]);
    expect(picks[2]!.referenceUse).toBe('none');
  });
  test('no frame at the level means a fresh slide even when other frames are free', () => {
    const picks = pickFramesByArc(deck(['high', 'high']) as never);
    expect(picks.map(p => p.frameIndex)).toEqual([0, null]);
  });
  test('with no arc the unused frames go out in source order, once each', () => {
    const flat = frames.map(f => ({ ...f, level: 'none' as const }));
    const picks = pickFramesByArc(deck(['none', 'none', 'none'], { arcAxis: '', sourceFrames: flat }) as never);
    expect(picks.map(p => p.frameIndex)).toEqual([0, 1, 2]);
  });
  test('referenceUse none attaches no frame', () => {
    const picks = pickFramesByArc(deck(['low', 'mid', 'high'], { keepSourceImage: false }) as never);
    expect(picks.every(p => p.frameIndex === null && p.referenceUse === 'none')).toBe(true);
  });
});

describe('invented-consistent identity chain and the single text field', () => {
  const c = normalizeContract(raw({
    identity: 'invented-consistent', identitySheet: 'A man, 25, short black hair, right profile', arcAxis: 'week 1 to week 4', subject: 'person',
    slides: [slide({ overlayText: '4 weeks of neck curls', arcLevel: 'low' }), slide({ overlayText: 'week 2', arcLevel: 'mid', visibleChange: 'neck as wide as the jaw' }), slide({ overlayText: 'week 4', arcLevel: 'high', visibleChange: 'neck wider than the jaw' })],
  }), input());
  const picks = pickFramesByArc(c);
  test('slide 1 is fresh and slides 2..N are edits of it', () => {
    expect([0, 1, 2].map(i => slideRole(c, i, picks[i]!))).toEqual(['fresh', 'anchor-edit', 'anchor-edit']);
  });
  test('overlayText reaches the prompt verbatim and hook is derived from slide 1', () => {
    expect(c.hook).toBe('4 weeks of neck curls');
    expect(compileSlidePrompt(c, 0, 'fresh', 'none')).toContain('render exactly "4 weeks of neck curls"');
    expect(compileSlidePrompt(c, 1, 'anchor-edit', 'none')).toContain('render exactly "week 2"');
    expect(compileSlidePrompt(c, 0, 'fresh', 'none')).toContain('SUBJECT: A man, 25, short black hair, right profile');
  });
  test('no slide numbers and no hard-coded medium lines in any prompt', () => {
    for (const [i, role] of [[0, 'fresh'], [1, 'anchor-edit'], [2, 'edit']] as const) {
      const p = compileSlidePrompt(c, i, role, 'none');
      expect(p).not.toMatch(/slide\s*\d|slide\s+\d+\s+of/i);
      expect(p).not.toMatch(/COLLAGE|caricature|No app UI/);
    }
    expect(compileSlidePrompt(c, 1, 'anchor-edit', 'none')).toContain('Change ONLY this: neck as wide as the jaw');
  });
  test('the story position is drawn, never printed as a scale or tier label', () => {
    for (const [i, role] of [[0, 'fresh'], [1, 'anchor-edit']] as const) {
      expect(compileSlidePrompt(c, i, role, 'none')).toContain('Do not write the axis, its end labels, a scale, a slider, a tier or level name');
    }
  });
  test('the edit template removes only overlaid captions and keeps clothing prints', () => {
    const p = compileSlidePrompt(c, 0, 'edit', 'edit');
    expect(p).toContain('INCLUDING any print or graphic on clothing');
    expect(p).toContain('Remove only caption text that was overlaid');
  });
  test('an empty caption renders with no text', () => {
    const noText = normalizeContract(raw(), input());
    expect(compileSlidePrompt({ ...noText, slides: [slide({ overlayText: '' }) as never, ...noText.slides.slice(1)] }, 0, 'fresh', 'none')).toContain('TEXT: no caption, no words.');
  });
});

describe('QA is compiled from the same contract', () => {
  const c = normalizeContract(raw({
    arcAxis: 'low to high', identity: 'invented-consistent', identitySheet: 'a man',
    slides: [slide({ overlayText: 'a', arcLevel: 'low' }), slide({ overlayText: 'b', arcLevel: 'mid' }), slide({ overlayText: 'c', arcLevel: 'high' })],
  }), input());
  const ok = (index: number, level: string) => ({ index, textSeen: '', overlayExact: true, sceneMatches: true, stateLevel: level, mediumMatches: true, lockResults: [] });
  const deck = { identityConsistent: true, sourceLikeness: false, arcVisibleWithoutText: true, notes: '' };
  test('lists every hard lock but no source default', () => {
    const p = compileQaPrompt(c, { slideCount: 3, sourceImages: 1, referenceUse: 'none' });
    expect(p).toContain('Faceless: no face visible');
    expect(p).not.toContain('2x2 food grid');
    expect(p).toContain('ignoring captions');
  });
  test('a clean answer passes', () => {
    expect(qaVerdict(c, { slides: [ok(0, 'low'), ok(1, 'mid'), ok(2, 'high')], deck } as never).passed).toBe(true);
  });
  test('caption, lock, arc and deck failures are hard', () => {
    const q = { slides: [{ ...ok(0, 'low'), overlayExact: false, textSeen: 'zzz' }, { ...ok(1, 'mid'), lockResults: [{ lock: 'Faceless: no face visible', pass: false, note: 'face' }] }, ok(2, 'low')], deck: { ...deck, identityConsistent: false, sourceLikeness: true, arcVisibleWithoutText: false } };
    const v = qaVerdict(c, q as never);
    expect(v.passed).toBe(false);
    expect(v.failures['0']![0]).toContain('exactly "a"');
    expect(v.failures['1']![0]).toContain('Faceless');
    expect(v.failures['2']![0]).toContain('must read as high');
    expect(v.failures.deck!.length).toBe(3);
    expect(repairSlides(v.failures, 3)).toEqual([0, 1, 2]);
  });
  test('in edit mode a missing arc is a warning and the picture state is not judged', () => {
    const e = normalizeContract(raw({ keepSourceImage: true, arcAxis: 'low to high', slides: [slide({ arcLevel: 'low' }), slide({ arcLevel: 'mid' }), slide({ arcLevel: 'high' })] }), input());
    const v = qaVerdict(e, { slides: [ok(0, 'high'), ok(1, 'high'), ok(2, 'high')], deck: { ...deck, arcVisibleWithoutText: false, notes: 'flat' } } as never);
    expect(v.passed).toBe(true);
    expect(v.warnings.length).toBe(1);
  });
  test('only the touched slides are judged when asked', () => {
    const q = { slides: [ok(0, 'low'), { ...ok(1, 'mid'), overlayExact: false }, ok(2, 'high')], deck };
    expect(qaVerdict(c, q as never, { slides: [0] }).passed).toBe(true);
  });
});

describe('A/B arms differ only in the declared variable', () => {
  const a: ArmBrief = { character: 'a man', visualStyle: 'pencil', caption: 'cap', cta: 'cta', slides: [slide({ overlayText: 'Hook A', arcLevel: 'low' }) as never, slide({ overlayText: 'two', arcLevel: 'high' }) as never, slide({ overlayText: 'three', arcLevel: 'high' }) as never] };
  const mk = (variable: string, value: string, slides: never[] = []) => ({ variable, value, slides });
  test('hook changes slide-1 text only and reuses the rest', () => {
    const b = buildArmB(a, mk('hook', 'Hook B'));
    expect(diffArms(a, b)).toEqual(['hook']);
    expect([0, 1, 2].map(i => slideWork(a, b, i))).toEqual(['caption-edit', 'reuse', 'reuse']);
    expect(() => assertArmsDifferOnly(a, b, 'hook')).not.toThrow();
    expect(captionEditPrompt('Hook A', 'Hook B')).toContain('replace the caption "Hook A" with exactly "Hook B"');
  });
  test('caption and cta need no slide work', () => {
    for (const [v, f] of [['caption', 'caption'], ['cta', 'cta']] as const) {
      const b = buildArmB(a, mk(v, 'new'));
      expect(diffArms(a, b)).toEqual([f]);
      expect([0, 1, 2].every(i => slideWork(a, b, i) === 'reuse')).toBe(true);
    }
  });
  test('character and visualStyle re-render every slide', () => {
    for (const [v, f] of [['character', 'character'], ['visualStyle', 'visualStyle']] as const) {
      const b = buildArmB(a, mk(v, 'new'));
      expect(diffArms(a, b)).toEqual([f]);
      expect([0, 1, 2].every(i => slideWork(a, b, i) === 'render')).toBe(true);
    }
  });
  test('a concept change re-renders only the slides that changed', () => {
    const alt = [a.slides[0]!, { ...a.slides[1]!, scene: 'other scene' }, a.slides[2]!] as never[];
    const b = buildArmB(a, mk('concept', '', alt));
    expect([0, 1, 2].map(i => slideWork(a, b, i))).toEqual(['reuse', 'render', 'reuse']);
    expect(() => assertArmsDifferOnly(a, b, 'concept')).not.toThrow();
  });
  test('an arm that changes something else is rejected', () => {
    const b = buildArmB(a, mk('hook', 'Hook B'));
    b.visualStyle = 'photo';
    expect(() => assertArmsDifferOnly(a, b, 'hook')).toThrow(ContractError);
  });
  test('a missing arm B value is rejected at normalization', () => {
    expect(() => normalizeContract(raw({ variantB: { variable: 'hook', value: ' ', slides: [] } }), input())).toThrow(ContractError);
    expect(() => normalizeContract(raw({ variantB: { variable: 'concept', value: '', slides: [] } }), input({ variable: 'concept' }))).toThrow(ContractError);
  });
});

test('the resolved type is exported', () => {
  const c: ResolvedContract = normalizeContract(raw(), input());
  expect(c.version).toBe(1);
});
