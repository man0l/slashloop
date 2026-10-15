// SLA-867: morph identity mode. One invented subject graded slide by slide on visible attributes,
// valuation copy drawn in code and never sent to the image model.
import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  MORPH_ATTRIBUTES, MorphError, assertNoValuationWords, morphBlock, morphChecks, normalizeMorphSlides, redactValuation, valuationWords,
} from './morph.js';
import {
  ContractError, MORPH_CONTRACT_JSON_SCHEMA, buildArmB, compileQaPrompt, compileSlidePrompt, contractFieldGuide, contractJsonSchema, diffArms,
  morphQaChecks, normalizeContract, qaJsonSchema, qaVerdict, slideRole, tagLocks, pickFramesByArc, type ContractInput, type QaAnswer,
} from './resolved-contract.js';
import { universalLocks } from './source-format.js';
import { composeOverlay } from './overlay-compose.js';
import { Instructions } from './schema.js';
import { defaultExperimentCap, editInstructions } from '../tools/experiments.js';
import { slideFanout } from './schema.js';

// The 9ef391b8 source (faceless maxxing, 1.3M views): the analyzer's eight slide labels, in order.
const LABELS = [
  'CHAD\n2% of population', 'CHADLITE\n4% of population', 'HTN\n20% of population', 'MTN\n30% of population',
  'LTN\n25% of population', 'SUB 5\n7% of population', 'SUB 3\n12% of population', 'PSL  6.2 • Chad    POTENTIAL  6.7 • Chad',
];
// What a planner reads off those frames ("rounder, puffier face, less defined jaw, heavier cheeks, messier hair").
const GRADES: Record<string, number[]> = {
  'jaw definition': [4, 4, 4, 3, 2, 1, 0, 0],
  'cheek fullness': [0, 0, 0, 1, 2, 3, 4, 4],
  hairline: [4, 4, 4, 4, 3, 2, 1, 1],
  expression: [3, 3, 3, 3, 2, 2, 1, 0],
};
const SCENE = 'head-and-shoulders studio portrait against a seamless gray backdrop, even soft studio light, eye-level camera';
const slideAt = (i: number, grades = GRADES) => ({
  overlayText: LABELS[i]!, arcLevel: 'none', scene: SCENE, composition: 'centred close-up, face fully visible', visibleChange: '',
  morph: Object.entries(grades).map(([attribute, g]) => ({ attribute, grade: g[i]! })),
});
const input = (o: Partial<ContractInput> = {}): ContractInput => ({
  direction: 'Keep the source format: one invented man graded slide by slide, labels copied exactly.', slideCount: 8, frameCount: 8, variable: 'morph', morph: true,
  locks: tagLocks([...universalLocks()], universalLocks()), sourceDefaults: [], ...o,
});
const raw = (o: Record<string, unknown> = {}) => ({
  droppedSourceDefaults: [], droppedLocks: [], subject: 'person', identity: 'invented-consistent',
  identitySheet: 'an invented man in his mid twenties, tanned skin, thick wavy black hair, light hazel-green eyes, black crew-neck t-shirt',
  medium: 'photorealistic studio photograph', keepSourceImage: false, borrowSourceLook: true, arcAxis: '',
  sourceFrameLevels: LABELS.map((_, index) => ({ index, level: 'none', showsPerson: index < 7 })),
  morph: { axis: 'face gets rounder and softer', attributes: Object.keys(GRADES) },
  slides: LABELS.map((_, i) => slideAt(i)),
  variantB: {
    variable: 'morph', value: 'the softening starts earlier and stops halfway',
    slides: LABELS.map((_, i) => slideAt(i, {
      'jaw definition': [4, 3, 3, 2, 2, 2, 2, 2], 'cheek fullness': [0, 1, 1, 2, 2, 2, 2, 2], hairline: [4, 4, 3, 3, 3, 3, 3, 3], expression: [3, 3, 2, 2, 2, 2, 2, 2],
    })),
  },
  ...o,
});

describe('morph grades', () => {
  test('a monotone deck compiles; equal steps are allowed', () => {
    const decks = normalizeMorphSlides([[{ attribute: 'jaw', grade: 4 }], [{ attribute: 'jaw definition', grade: 4 }], [{ attribute: 'Jaw Definition', grade: 1 }]]);
    expect(decks.map(d => d[0]!.grade)).toEqual([4, 4, 1]);
  });

  test('grades that change direction fail with morph_not_monotone', () => {
    const run = () => normalizeMorphSlides([[{ attribute: 'cheek fullness', grade: 0 }], [{ attribute: 'cheek fullness', grade: 3 }], [{ attribute: 'cheek fullness', grade: 1 }]]);
    expect(run).toThrow(MorphError);
    try { run(); } catch (err) { expect((err as MorphError).code).toBe('morph_not_monotone'); }
  });

  test('an unknown attribute, a flat deck and a slide 1 that omits an attribute are refused', () => {
    const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (err) { return (err as MorphError).code; } };
    expect(code(() => normalizeMorphSlides([[{ attribute: 'attractiveness', grade: 4 }]]))).toBe('morph_invalid');
    expect(code(() => normalizeMorphSlides([[{ attribute: 'neck', grade: 2 }], [{ attribute: 'neck', grade: 2 }]]))).toBe('morph_flat');
    expect(code(() => normalizeMorphSlides([[{ attribute: 'neck', grade: 2 }], [{ attribute: 'hairline', grade: 1 }]], ['neck width', 'hairline']))).toBe('morph_invalid');
  });

  test('a slide that omits an attribute keeps the previous grade', () => {
    const decks = normalizeMorphSlides([[{ attribute: 'neck', grade: 0 }, { attribute: 'skin', grade: 0 }], [{ attribute: 'neck', grade: 2 }], [{ attribute: 'skin', grade: 3 }]]);
    expect(decks[2]).toEqual([{ attribute: 'neck width', grade: 2 }, { attribute: 'skin texture', grade: 3 }]);
  });
});

describe('valuation lint', () => {
  test('catches tier, score, hormone and percentage words, never ordinary ones', () => {
    expect(valuationWords('CHAD 2% of population, sub 5, high testosterone, PSL score, ugly')).toEqual(['chad', 'sub', 'psl', 'testosterone', 'ugly', 'score', 'percent']);
    expect(valuationWords('the subject, a subtle change, decorated backdrop, a soft jawline')).toEqual([]);
  });

  test('assertNoValuationWords names the field; redaction leaves no valuation word', () => {
    expect(() => assertNoValuationWords({ 'slides[2].scene': 'an HTN face' })).toThrow(/slides\[2\]\.scene \(htn\/mtn\/ltn\)/);
    expect(valuationWords(redactValuation('make him look more chad, like a sub 3, low testosterone'))).toEqual([]);
  });
});

describe('contract compile (morph)', () => {
  test('the 9ef391b8 planner answer compiles to an 8-slide monotone morph deck with labels kept as overlay copy', () => {
    const c = normalizeContract(raw(), input());
    expect(c.morph).toEqual({ axis: 'face gets rounder and softer', attributes: ['jaw definition', 'cheek fullness', 'hairline', 'expression'] });
    expect(c.slides).toHaveLength(8);
    expect(c.identity).toBe('invented-consistent');
    expect(c.keepSourceImage).toBe(false);
    for (const a of c.morph!.attributes) {
      const g = c.slides.map(s => s.morph!.find(m => m.attribute === a)!.grade);
      expect(g.every((x, i) => i === 0 || x <= g[i - 1]!) || g.every((x, i) => i === 0 || x >= g[i - 1]!)).toBe(true);
    }
    expect(c.slides.map(s => s.overlayText)).toEqual(LABELS);
    expect(c.slides[0]!.visibleChange).toBe('');
    expect(c.slides[6]!.visibleChange).toContain('jaw definition: a soft, rounded jawline');
    expect(valuationWords(c.slides.map(s => s.visibleChange).join(' '))).toEqual([]);
  });

  test('the model may not keep the source photos or the source person', () => {
    const c = normalizeContract(raw({ keepSourceImage: true, identity: 'source', arcAxis: 'tier' }), input());
    expect(c.keepSourceImage).toBe(false);
    expect(c.identity).toBe('invented-consistent');
    expect(c.arcAxis).toBe('');
    expect(c.issues.join(' ')).toMatch(/morph deck/);
  });

  test('non-monotone grades fail the contract with morph_not_monotone', () => {
    const bad = raw({ slides: LABELS.map((_, i) => slideAt(i, { ...GRADES, 'jaw definition': [4, 3, 4, 2, 2, 1, 0, 0] })) });
    try { normalizeContract(bad, input()); throw new Error('compiled'); } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).code).toBe('morph_not_monotone');
    }
  });

  test('a valuation word in a scene, the identity sheet or a lock fails the contract', () => {
    const code = (r: unknown, i = input()) => { try { normalizeContract(r, i); return 'ok'; } catch (err) { return (err as ContractError).code; } };
    const scenes = LABELS.map((_, i) => ({ ...slideAt(i), scene: i === 3 ? `${SCENE}, an MTN face` : SCENE }));
    expect(code(raw({ slides: scenes }))).toBe('morph_valuation_words');
    expect(code(raw({ identitySheet: 'a chad-looking man' }))).toBe('morph_valuation_words');
    expect(code(raw(), input({ locks: tagLocks(['make him look low testosterone at the end'], universalLocks()) }))).toBe('morph_valuation_words');
  });

  test('arm B keeps arm A\'s slide 1 and labels and only regrades the later slides', () => {
    const c = normalizeContract(raw(), input());
    expect(c.variantB.variable).toBe('morph');
    expect(c.variantB.slides[0]!.morph).toEqual(c.slides[0]!.morph);
    expect(c.variantB.slides.map(s => s.overlayText)).toEqual(LABELS);
    const armA = { character: c.identitySheet, visualStyle: c.medium, caption: '', cta: '', morph: c.morph!.axis, slides: c.slides };
    const armB = buildArmB(armA, c.variantB);
    expect(diffArms(armA, armB)).toEqual(['morph']);
  });

  test('arm B grading exactly like arm A is refused', () => {
    expect(() => normalizeContract(raw({ variantB: { variable: 'morph', value: 'same', slides: LABELS.map((_, i) => slideAt(i)) } }), input())).toThrow(/different curve/);
  });

  test('the planner is asked for grades over the fixed vocabulary, without valuation words', () => {
    expect(contractJsonSchema(input())).toBe(MORPH_CONTRACT_JSON_SCHEMA);
    expect(contractJsonSchema(input({ morph: false }))).not.toBe(MORPH_CONTRACT_JSON_SCHEMA);
    const guide = contractFieldGuide(input());
    expect(guide['slides[].morph']).toContain('moves one way only');
    for (const a of MORPH_ATTRIBUTES) expect(guide.morph).toContain(a);
    expect(guide['slides[].scene']).toMatch(/Never write a valuation word/);
  });
});

describe('prompt compilation (morph)', () => {
  const c = normalizeContract(raw(), input());
  const promptView = { ...c, hook: '', slides: c.slides.map(s => ({ ...s, overlayText: '' })) };

  test('later slides edit slide 1 (the hero) with a MORPH block and never the IGNORE line', () => {
    const picks = pickFramesByArc(c);
    expect(slideRole(c, 0, picks[0]!)).toBe('fresh');
    expect(slideRole(c, 5, picks[5]!)).toBe('anchor-edit');
    const p = compileSlidePrompt(promptView, 5, 'anchor-edit', 'none');
    expect(p).toContain('MORPH: this is the SAME person as the attached frame');
    expect(p).toContain('Change ONLY these visible attributes');
    expect(p).toContain('jaw definition: now a soft jawline with a faint angle');
    expect(p).not.toMatch(/IGNORE/);
    expect(p).not.toMatch(/Only pose or expression may change/);
    expect(valuationWords(p)).toEqual([]);
  });

  test('no slide prompt carries a valuation word, even the CTA slide whose label is all valuation', () => {
    c.slides.forEach((_, i) => {
      const p = compileSlidePrompt(promptView, i, i === 0 ? 'fresh' : 'anchor-edit', i === 0 ? 'style-only' : 'none');
      expect(valuationWords(p)).toEqual([]);
      expect(p).not.toContain('population');
    });
  });

  test('QA fixes and human feedback are scrubbed before they reach the prompt', () => {
    const p = compileSlidePrompt(promptView, 3, 'anchor-edit', 'none', 'make him more chad', 'he should look like a sub 5');
    expect(valuationWords(p)).toEqual([]);
  });

  test('a valuation word that slipped into the overlay of a model-mode view fails the compile instead of reaching the provider', () => {
    expect(() => compileSlidePrompt(c, 0, 'fresh', 'none')).toThrow(ContractError);
  });

  test('morphBlock lists only the changed attributes and keeps the rest identical', () => {
    const anchor = [{ attribute: 'jaw definition' as const, grade: 4 }, { attribute: 'facial hair' as const, grade: 0 }];
    const b = morphBlock(anchor, [{ attribute: 'jaw definition', grade: 1 }, { attribute: 'facial hair', grade: 0 }]);
    expect(b).toContain('jaw definition: now');
    expect(b).toContain('including facial hair');
  });
});

describe('QA (morph)', () => {
  const c = normalizeContract(raw(), input());

  test('one check per morph attribute on every slide after the first, phrased against slide 1', () => {
    expect(morphQaChecks(c, 0)).toEqual([]);
    for (let i = 1; i < 8; i++) expect(morphQaChecks(c, i)).toHaveLength(c.morph!.attributes.length);
    expect(morphQaChecks(c, 6)[0]).toMatch(/^jaw definition has visibly changed from slide 1/);
    expect(morphQaChecks(c, 1)[0]).toMatch(/^jaw definition is unchanged from slide 1/);
    expect(morphChecks(c.slides[0]!.morph!, c.slides[6]!.morph!).map(x => x.attribute)).toEqual(c.morph!.attributes);
  });

  test('the judge prompt asks for samePerson and the checks, and never for attractiveness', () => {
    const p = compileQaPrompt(c, { slideCount: 8, sourceImages: 0, referenceUse: 'none' });
    expect(p).toContain('samePerson');
    expect(p).toContain(morphQaChecks(c, 6)[0]!);
    expect(p).toContain('Do NOT judge attractiveness');
    expect(qaJsonSchema(c)).not.toBe(qaJsonSchema({}));
  });

  const answer = (o: (i: number) => Partial<QaAnswer['slides'][number]> = () => ({})): QaAnswer => ({
    slides: c.slides.map((_, index) => ({ index, textSeen: '', overlayExact: true, sceneMatches: true, stateLevel: 'none', mediumMatches: true, lockResults: [],
      samePerson: true, morphChecks: morphQaChecks(c, index).map(check => ({ check, pass: true, note: '' })), ...o(index) })),
    deck: { identityConsistent: true, sourceLikeness: false, arcVisibleWithoutText: true, notes: '' },
  });

  test('passes when every check passes; a different person or a missed change fails that slide', () => {
    expect(qaVerdict(c, answer()).passed).toBe(true);
    const other = qaVerdict(c, answer(i => (i === 4 ? { samePerson: false } : {})));
    expect(other.failures['4']!.join(' ')).toMatch(/not the same person as slide 1/);
    const missed = qaVerdict(c, answer(i => (i === 6 ? { morphChecks: morphQaChecks(c, 6).map((check, k) => ({ check, pass: k !== 1, note: 'still lean' })) } : {})));
    expect(missed.failures['6']).toEqual([`${morphQaChecks(c, 6)[1]} (seen: still lean)`]);
    const unanswered = qaVerdict(c, answer(i => (i === 2 ? { morphChecks: [] } : {})));
    expect(unanswered.failures['2']!.every(f => f.startsWith('unchecked: '))).toBe(true);
  });
});

describe('variable, instructions and estimate', () => {
  const base = { goal: 'g', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], mode: 'controlled' as const };

  test('"ladder" is an alias of the morph variable, allowed in controlled mode', () => {
    expect(Instructions.parse({ ...base, variables: ['ladder'] }).variables).toEqual(['morph']);
  });

  test('a morph experiment cannot ask the image model to draw its labels', () => {
    expect(Instructions.safeParse({ ...base, variables: ['morph'], overlayMode: 'model' }).success).toBe(false);
  });

  test('edit mode: morph keeps the source labels, forces script overlays and refuses new copy', () => {
    const i = editInstructions(undefined, [], 'English', { variables: ['ladder'], morph: 'jaw softens across the deck' });
    expect(i).toMatchObject({ variables: ['morph'], overlayMode: 'script', mode: 'controlled' });
    expect(i.direction).toContain('Progression to test: jaw softens across the deck');
    expect(() => editInstructions('CHAD', [], 'English', { variables: ['morph'] })).toThrow(/Omit hook/);
    expect(() => editInstructions(undefined, [], 'English', { morph: 'x', variables: ['hook'] })).toThrow(/requires variables=\["morph"\]/);
  });

  test('the default cap prices a morph deck at 1 candidate per slide', () => {
    const one = defaultExperimentCap(2, 8, true, 1);
    expect(one).toBeLessThanOrEqual(defaultExperimentCap(2, 8, true, slideFanout()));
    expect(defaultExperimentCap(2, 8)).toBe(defaultExperimentCap(2, 8, true, slideFanout()));
  });
});

describe('stacked overlay (title + subtitle)', () => {
  const frame = () => sharp({ create: { width: 540, height: 960, channels: 3, background: { r: 40, g: 80, b: 120 } } }).jpeg().toBuffer();

  test('draws the title larger than the subtitle, both lines kept', async () => {
    const out = await composeOverlay({ buffer: await frame(), text: 'CHAD\n0.05% of population', slideIndex: 2, stacked: true });
    expect(out.lines).toEqual(['CHAD', '0.05% of population']);
    expect(out.fontSize).toBeGreaterThan(0);
    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([540, 960]);
  });

  test('a one-line label is drawn as before', async () => {
    const buffer = await frame();
    const stacked = await composeOverlay({ buffer, text: 'HIGH T', slideIndex: 1, stacked: true });
    const plain = await composeOverlay({ buffer, text: 'HIGH T', slideIndex: 1 });
    expect(stacked.lines).toEqual(plain.lines);
    expect(stacked.fontSize).toBe(plain.fontSize);
  });
});
