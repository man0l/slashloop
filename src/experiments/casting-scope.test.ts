// SLA-510 defect B: per-slide casting resolution.
//
// The fixtures are the VERBATIM saved character fields and slide scenes from the
// 2026-10-05 diagnostic ([SLA-502] attachment 7287ff97). Before the fix, every
// slide inherited the FIRST subject's clause of the roster — the slide whose
// scene said "red hair, a patchy beard, hazel eyes" was instructed "dark hair
// buzz, no beard" — and the deck's own "Unchanged: … gaze …" clause was read as
// a request to CHANGE gaze. Two instructions for one subject.
import { describe, expect, test } from 'bun:test';
import { compileSlideContract, contractPromptLines, contractChecks, parseCastingRequest, resolveSlideCasting, splitCastingClauses, type ObservedCopy } from './render-prompt.js';

const blank = (): ObservedCopy => ({ state: 'observed_empty', text: '' });
const sourceMap = { videoId: 'v', analysisId: 'a', sourceIndex: 0, referenceKind: 'slide', path: null };
function contract(scene: string, deckCasting: string, medium = 'collage') {
  return compileSlideContract({
    slideIndex: 0, role: 's', medium, scene, overlay: { mode: 'clear', text: '', origin: 'source' },
    observedCopy: blank(), sourceMap, deckCasting, identityLocked: false,
  });
}

const faceMorphCharacter = 'Sub 5: long recessed face, dark hair buzz, no beard, dark-circle grey eyes. Sub 3: round moon face, red hair, patchy beard, hazel eyes. Chad: sharp jaw, blonde part, light stubble, blue eyes. Unchanged: B&W line for subs, anime chad, 2x2 rich density, same setting composition story order, labels, expressions, gaze, backgrounds.';

const faceMorphScenes = [
  '2x2 collage at rich density. Bottom-left: black-and-white line drawing of a long recessed-face male with dark buzz-cut hair, no beard, and dark-circle grey eyes, labeled Sub 5. Bottom-right: photograph of a white bowl of oatmeal. Story beat: the fake-clean breakfast gets called not healthy.',
  '2x2 collage at rich density. Bottom-left: black-and-white line drawing of a round moon-faced male with red hair, a patchy beard, hazel eyes, oily skin and a soft neck, labeled Sub 3. Bottom-right: photograph of a dense pile of golden-brown chocolate-chip cookies. Story beat: the junk pile is also not healthy.',
  '2x2 collage at rich density. Bottom-left: clean-lined handsome anime-style male face with a sharp jaw, blonde side part, light stubble and calm blue eyes, labeled chad. Bottom-right: photograph of a wooden board holding five sunny-side-up fried eggs. Story beat: this plate is the healthy chad stack.',
];

const oilyCharacter = 'Sub 5: rectangular face, dark brown receding hair, stubble, brown eyes. Sub 3: moon-round face, sandy short hair, no beard but oily line work, green eyes. Chad: diamond face, black neat hair, light stubble, grey eyes. Unchanged: roles, labels Sub 5/Sub 3/chad, drawing mediums, composition, story order, density, gaze, expression, no added items.';

describe('the roster is split into labelled subjects and preservation clauses', () => {
  test('labels, bodies and the Unchanged clause are separated', () => {
    const clauses = splitCastingClauses(faceMorphCharacter);
    expect(clauses.map(c => c.label)).toEqual(['Sub 5', 'Sub 3', 'Chad', null]);
    expect(clauses[3]!.body).toBe('Unchanged: B&W line for subs, anime chad, 2x2 rich density, same setting composition story order, labels, expressions, gaze, backgrounds.');
  });

  test('a single-subject field stays one unlabelled clause', () => {
    expect(splitCastingClauses('male with curly dark hair and green eyes')).toEqual([{ label: null, body: 'male with curly dark hair and green eyes' }]);
  });
});

describe('each slide resolves its own subject (defect B)', () => {
  for (const [name, field] of [['Face Morph Breakfast', faceMorphCharacter], ['Oily Moonface Insult', oilyCharacter]] as const) {
    test(`${name}: slide 1 takes Sub 5, slide 2 takes Sub 3, slide 3 takes Chad`, () => {
      expect(resolveSlideCasting(faceMorphScenes[0]!, field).subject).toBe('Sub 5');
      expect(resolveSlideCasting(faceMorphScenes[1]!, field).subject).toBe('Sub 3');
      expect(resolveSlideCasting(faceMorphScenes[2]!, field).subject).toBe('Chad');
    });
  }

  test('no slide inherits another subject’s attributes', () => {
    for (const scene of faceMorphScenes) {
      const resolved = resolveSlideCasting(scene, faceMorphCharacter);
      const contract = compileSlideContract({
        slideIndex: 0, role: 's', medium: 'collage', scene, overlay: { mode: 'clear', text: '', origin: 'source' },
        observedCopy: blank(), sourceMap, deckCasting: faceMorphCharacter, identityLocked: false,
      });
      // The subject's own requested value is present; the other subjects' values
      // are not, and nothing the request did not name became a target.
      const expected: Record<string, string> = {
        'Sub 5': 'dark hair buzz', 'Sub 3': 'red hair', chad: 'blonde part',
      };
      expect(contract.subject.castingTarget.hair).toBe(expected[resolved.subject!]);
      expect(contract.subject.resolution!.skipped.filter(s => s.reason === 'not_this_slide')).toHaveLength(2);
    }
  });

  test('the compiled scene states the requested value and never the superseded one', () => {
    const built = contract(faceMorphScenes[1]!, faceMorphCharacter);
    // Slide 2 (Sub 3): the request asks for red hair and the scene already says
    // red hair, so nothing is superseded and nothing contradicts.
    expect(built.subject.castingTarget).toMatchObject({ hair: 'red hair', 'facial-hair': 'patchy beard', eyes: 'hazel eyes' });
    for (const phrase of built.subject.supersededPhrases) {
      if (!Object.values(built.subject.castingTarget).includes(phrase)) expect(built.compiledScene).not.toContain(phrase);
    }
    // The Sub 5 and Chad values never reach slide 2 in any form.
    expect(built.compiledScene).not.toContain('dark hair buzz');
    expect(built.compiledScene).not.toContain('blonde part');
  });

  test('a genuinely conflicting scene is rewritten to the requested value only', () => {
    // Slide 1 keeps the source's Sub 5 wording when it already matches the request.
    const built = contract(faceMorphScenes[0]!, faceMorphCharacter);
    expect(built.subject.castingTarget.hair).toBe('dark hair buzz');
    expect(built.subject.castingTarget).not.toHaveProperty('gaze');
    expect(built.subject.lockedAttributes.some(l => l.attribute === 'gaze')).toBe(true);
  });

  test('an "Unchanged: … gaze …" clause never unlocks gaze', () => {
    const built = contract(faceMorphScenes[2]!, faceMorphCharacter);
    expect(built.subject.castingTarget).not.toHaveProperty('gaze');
    expect(parseCastingRequest('Unchanged: gaze, backgrounds')).toEqual({ targets: [], unresolved: null });
    expect(built.subject.resolution!.skipped.some(s => s.reason === 'preservation')).toBe(true);
  });

  test('a slide whose subject the roster never names keeps its own scene casting', () => {
    // A roster about Sub 5/Sub 3/Chad, and a slide showing a plate of food.
    const foodScene = 'Photograph of a white bowl of oatmeal densely topped with neatly arranged banana slices on a marble counter.';
    const built = contract(foodScene, faceMorphCharacter);
    expect(built.subject.identityMode).toBe('preserve');
    expect(built.subject.castingTarget).toEqual({});
    expect(built.compiledScene).toBe(foodScene);
    const lines = contractPromptLines(built).join('\n');
    expect(lines).toContain('CASTING SCOPE');
    expect(lines).toContain('do NOT apply them here');
    // The subject this slide does describe is still named as preserved.
    expect(lines).toContain('PRESERVE');
  });

  test('a scene naming two roster subjects is ambiguous, so neither is applied', () => {
    const twoSubjects = 'Side-by-side portraits: a buzz-cut man labeled Sub 5 and a blonde anime chad labeled chad.';
    const built = contract(twoSubjects, faceMorphCharacter);
    expect(built.subject.identityMode).toBe('preserve');
    expect(built.subject.castingTarget).toEqual({});
    expect(built.subject.resolution!.skipped.every(s => s.reason === 'ambiguous_subject' || s.reason === 'preservation')).toBe(true);
    expect(built.compiledScene).toBe(twoSubjects);
  });

  test('a single-subject field still applies to every slide, as before', () => {
    const field = 'female with long straight or pulled-back blonde/light hair, light eyes';
    for (const scene of ['A woman with dark hair pulled back wearing a black top, looking at the camera.', 'A woman with brown hair and a silver necklace, looking left.']) {
      const built = contract(scene, field, 'photograph');
      expect(built.subject.castingTarget).toMatchObject({ hair: 'long straight or pulled-back blonde/light hair', eyes: 'light eyes' });
      expect(built.subject.resolution!.subject).toBeNull();
      expect(built.subject.resolution!.skipped).toEqual([]);
    }
  });

  test('the same target reaches the render prompt and the QA checks', () => {
    const built = contract(faceMorphScenes[1]!, faceMorphCharacter);
    const checks = contractChecks(built);
    expect(contractPromptLines(built).join('\n')).toContain('CASTING TARGET');
    expect(checks).toContain("the subject's hair matches the requested casting target: red hair");
    expect(checks.some(c => c.includes('gaze is unchanged'))).toBe(true);
    expect(checks.some(c => c.includes('role is unchanged'))).toBe(true);
  });
});

describe('the multi-attribute clause no longer rewrites a locked attribute', () => {
  const field = 'Seven-plate series of a fair-skinned young man with platinum-blonde buzzed sides and longer top, ice-blue eyes, clean-shaven, wide square face; unchanged: black t-shirt, no jewelry, gray backdrop, same layout and framing, neutral expression, medium-density photograph, same ladder roles';
  const scene = 'a head-and-shoulders studio portrait centered on a fair-skinned young man with copper-red hair, blue-green eyes, a sharp jaw, and full lips, wearing a black t-shirt against a solid gray backdrop, neutral model stare.';

  test('hair and eyes change; the wardrobe and backdrop survive', () => {
    const built = contract(scene, field, 'photograph');
    expect(built.subject.castingTarget).toMatchObject({ hair: 'platinum-blonde buzzed sides', eyes: 'ice-blue eyes' });
    expect(built.subject.castingTarget).not.toHaveProperty('wardrobe');
    expect(built.subject.castingTarget).not.toHaveProperty('setting');
    expect(built.compiledScene).toContain('a black t-shirt');
    expect(built.compiledScene).toContain('solid gray backdrop');
    // The scene's own hair and eye wording is replaced, not doubled.
    expect(built.compiledScene).not.toContain('copper-red hair');
    expect(built.compiledScene).not.toContain('blue-green ice-blue');
  });

  test('the "young man with …" lead-in never unlocks the subject role', () => {
    const built = contract(scene, field, 'photograph');
    expect(built.subject.castingTarget.role).toBeUndefined();
    expect(built.compiledScene).toContain('young man');
    expect(built.subject.lockedAttributes.find(l => l.attribute === 'role')?.observed).toBe('man');
  });

  test('an attribute a preservation clause names can never be a target', () => {
    // "unchanged: black t-shirt" plus a casting clause that also names a top: the
    // preservation wins, and the skip is recorded rather than silent.
    const conflicting = 'man with a black tank top, unchanged: black t-shirt';
    const resolved = resolveSlideCasting('A man with a black t-shirt holding a phone.', conflicting);
    expect(resolved.targets.some(t => t.attribute === 'wardrobe')).toBe(false);
    expect(resolved.skipped.some(s => s.reason === 'attribute_preserved' || s.reason === 'descriptive_clause')).toBe(true);
  });

  test('a hair or eye value the scene never states is carried by the CASTING TARGET line', () => {
    const built = contract('a studio portrait of a person against a plain backdrop.', field, 'photograph');
    expect(built.subject.castingTarget).toMatchObject({ hair: 'platinum-blonde buzzed sides', eyes: 'ice-blue eyes' });
    // Nothing in that scene states these attributes, so the scene prose is
    // untouched and the value reaches the render prompt and QA checks instead.
    expect(built.compiledScene).toBe('a studio portrait of a person against a plain backdrop.');
    expect(contractChecks(built)).toContain("the subject's hair matches the requested casting target: platinum-blonde buzzed sides");
  });
});

describe('hook-only and unchanged-copy paths keep their identity locks', () => {
  test('an identity-locked slide compiles no casting target and no scope line', () => {
    const built = compileSlideContract({
      slideIndex: 0, role: 's', medium: 'collage', scene: faceMorphScenes[1]!, overlay: { mode: 'clear', text: '', origin: 'source' },
      observedCopy: blank(), sourceMap, deckCasting: faceMorphCharacter, identityLocked: true,
    });
    expect(built.subject.identityMode).toBe('preserve');
    expect(built.subject.castingTarget).toEqual({});
    expect(built.subject.resolution).toBeUndefined();
    expect(built.compiledScene).toBe(faceMorphScenes[1]);
    expect(contractPromptLines(built).join('\n')).not.toContain('CASTING');
  });

  test('a locked-identity deck that never unlocked character resolves to no request', () => {
    const built = compileSlideContract({
      slideIndex: 2, role: 'payoff', medium: 'photograph',
      scene: 'a head-and-shoulders portrait of a fair-skinned young man with copper-red hair, blue-green eyes, wearing a black t-shirt against a solid gray backdrop.',
      overlay: { mode: 'replace', text: 'average european', origin: 'brief' }, observedCopy: blank(),
      sourceMap, deckCasting: null, identityLocked: true,
    });
    expect(built.subject.castingTarget).toEqual({});
    expect(built.overlay).toEqual({ mode: 'replace', text: 'average european', origin: 'brief' });
    expect(built.subject.lockedAttributes.find(l => l.attribute === 'hair')?.observed).toBe('copper-red hair');
  });
});