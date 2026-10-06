// SLA-528 (follow-up to the SLA-525 investigation of experiment 99c064b6).
//
// Fixtures are the VERBATIM saved brief fields of variant 04c59a9d ("Face Morph
// Breakfast"): the deck-level character field and the three slide scenes. The
// per-slide source copy is the recorded analysis copy of the source video —
// slide 3's is "but this is...", NOT the burned-in handle — so the handle cases
// below are synthetic and say so.
import { describe, expect, test } from 'bun:test';
import {
  appearanceSpans, compileSlideContract, contractChecks, contractPromptLines, labelPolicy, overlayDecision,
  parseCastingRequest, subjectScope, type ObservedCopy, type OverlayDecision,
} from './render-prompt.js';
import { qaTerminalMessage } from './providers.js';
import { experimentProgress, isTerminalQaError } from '../tools/experiments.js';
import type { Experiment } from './schema.js';

const DECK_CASTING =
  'Sub 5: long recessed face, dark hair buzz, no beard, dark-circle grey eyes. ' +
  'Sub 3: round moon face, red hair, patchy beard, hazel eyes. ' +
  'Chad: sharp jaw, blonde part, light stubble, blue eyes. ' +
  'Unchanged: B&W line for subs, anime chad, 2x2 rich density, same setting composition story order, labels, expressions, gaze, backgrounds.';

const SLIDES = [
  { index: 0, role: 'hook', copy: 'this is not healthy..',
    scene: '2x2 collage at rich density. Top-left: photograph of a white bowl on white marble holding two halved hard-boiled eggs with visible yolks plus a cluster of blueberries. Top-right: photograph of a white round plate with two triangular toasted bread slices and two whole peeled boiled eggs. Bottom-left: black-and-white line drawing of a long-faced recessed-jaw dark-circle male with a thinning hairline, labeled Sub 5. Bottom-right: photograph of a white bowl of oatmeal densely topped with neatly arranged banana slices. Story beat: the fake-clean breakfast gets called not healthy.' },
  { index: 1, role: 'build', copy: 'also this isnt healthy...',
    scene: '2x2 collage at rich density. Top-left: photograph of a pile of golden fried chicken tenders, crinkle-cut fries, fried biscuits and three small cups of orange dipping sauce. Top-right: photograph of a stack of pale rolled crepes or pancakes filled and drizzled with glossy chocolate spread. Bottom-left: black-and-white line drawing of a round moon-faced male with red hair, a patchy beard, hazel eyes, oily skin and a soft neck, labeled Sub 3. Bottom-right: photograph of a dense pile of golden-brown chocolate-chip cookies, some sprinkled with sea salt. Story beat: the junk pile is also not healthy.' },
  { index: 2, role: 'payoff', copy: 'but this is...',
    scene: '2x2 collage at rich density. Top-left: photograph of a handheld wooden board loaded with diced pineapple, blackberries, strawberries, kiwi and apple slices, a square of dark chocolate, steak topped with onions, a fried egg, avocado halves and cherry tomatoes, faint watermark ‘Back on my shï’. Top-right: photograph of a wooden table covered with four large water jugs, vacuum-packed meats, ghee, rustic bread, cartons of brown eggs, berries, squash, broccoli, onions, potatoes, avocados, dates and honey. Bottom-left: clean-lined handsome anime-style male face with a sharp jaw, blonde side part, light stubble and calm blue eyes, labeled chad. Bottom-right: photograph of a wooden board holding five sunny-side-up fried eggs, four avocados and a sliced grilled steak. Story beat: this plate is the healthy chad stack.' },
] as const;

const LOCKS = ['keep the story line'];
function compile(i: number, over: { overlay?: OverlayDecision; copy?: string; labels?: ReturnType<typeof labelPolicy> } = {}) {
  const slide = SLIDES[i]!;
  const copy = over.copy ?? slide.copy;
  const observed: ObservedCopy = { state: 'observed_text', text: copy };
  return compileSlideContract({
    slideIndex: slide.index, role: slide.role, medium: 'photograph', scene: slide.scene,
    overlay: over.overlay ?? overlayDecision({ source: observed, hasOverride: false, overrideText: null, briefText: copy, copyUnlocked: false }),
    observedCopy: observed, deckCasting: DECK_CASTING, castingRequest: DECK_CASTING, identityLocked: false,
    sourceMap: { videoId: 'v', analysisId: null, sourceIndex: slide.index, referenceKind: 'mapped', path: null },
    sceneLocks: LOCKS, labels: over.labels ?? labelPolicy(LOCKS),
  });
}

describe('medium-aware casting: no colour is asked of a colourless subject', () => {
  test('slide 2 (black-and-white Sub 3) emits no colour check and says why', () => {
    const c = compile(1);
    const checks = contractChecks(c);
    expect(checks.join('\n')).not.toMatch(/hazel|red hair/);
    expect(c.subject.castingTarget).toEqual({ 'facial-hair': 'patchy beard' });
    expect(c.subject.withheld).toEqual(['red hair', 'hazel eyes']);
    expect(c.subject.withheldReason).toBe('monochrome_medium');
    expect(c.subject.resolution!.skipped.filter(s => s.reason === 'monochrome_medium').map(s => s.clause)).toEqual(['red hair', 'hazel eyes']);
    expect(contractPromptLines(c).join('\n')).toContain('no colour');
  });

  test('the scene stating those colours is not turned into a preserve-colour lock either', () => {
    const c = compile(1);
    const lock = (a: string) => c.subject.lockedAttributes.find(l => l.attribute === a)!;
    expect(lock('hair').observed).toBeNull();
    expect(lock('eyes').observed).toBeNull();
    const preserve = contractPromptLines(c).find(l => l.startsWith('PRESERVE'))!;
    expect(preserve).not.toMatch(/hazel|red hair/);
  });

  test('achromatic targets on a drawing are kept (grey eyes on slide 1)', () => {
    const c = compile(0);
    expect(c.subject.castingTarget).toMatchObject({ hair: 'dark hair buzz', eyes: 'dark-circle grey eyes' });
    expect(c.subject.withheld ?? []).toEqual([]);
  });

  test('a colour subject in the same collage family keeps its colour (slide 3 anime chad)', () => {
    const c = compile(2);
    expect(c.subject.castingTarget).toMatchObject({ eyes: 'blue eyes', hair: 'blonde part' });
    expect(c.subject.withheld ?? []).toEqual([]);
  });

  test('a photograph in the next quadrant does not make the subject colourless', () => {
    const scene = '2x2 collage. Top-left: black-and-white photograph of a bowl of eggs. Bottom-left: colour illustration of a male with dark hair and brown eyes, labeled Sub 3.';
    const c = compileSlideContract({
      slideIndex: 0, role: 's', medium: 'collage', scene, overlay: { mode: 'clear', text: '', origin: 'source' }, observedCopy: null,
      deckCasting: 'Sub 3: red hair, hazel eyes', identityLocked: false,
      sourceMap: { videoId: 'v', analysisId: null, sourceIndex: 0, referenceKind: 'mapped', path: null },
    });
    expect(c.subject.castingTarget).toEqual({ hair: 'red hair', eyes: 'hazel eyes' });
  });
});

describe('overlay copy and the removal list never demand the same mark', () => {
  const required = (checks: string[]) => checks.filter(c => c.startsWith('the on-image overlay matches exactly')).join();
  const forbidden = (checks: string[]) => checks.filter(c => c.startsWith('the mark ')).join();

  test('the recorded overlay copy of all three slides compiles unchanged', () => {
    for (const i of [0, 1, 2]) expect(compile(i).overlay).toEqual({ mode: 'preserve', text: SLIDES[i]!.copy, origin: 'source' });
  });

  test('a preserved source overlay that IS the burned-in handle is cleared, not required', () => {
    const c = compile(2, { copy: '@backonshii' });
    expect(c.overlay).toEqual({ mode: 'clear', text: '', origin: 'source' });
    const checks = contractChecks(c);
    expect(required(checks)).toBe('');
    expect(forbidden(checks)).toContain('platform usernames and @handles');
    expect(checks).toContain('the slide carries no added overlay text');
  });

  test('a handle inside longer preserved copy is stripped from the requirement', () => {
    const c = compile(2, { copy: 'but this is... @backonshii' });
    expect(c.overlay).toEqual({ mode: 'preserve', text: 'but this is...', origin: 'source' });
    expect(required(contractChecks(c))).not.toContain('@');
  });

  test('explicit override copy is the author\'s own and is never rewritten', () => {
    const overlay: OverlayDecision = { mode: 'replace', text: 'follow @slashloop', origin: 'override' };
    expect(compile(2, { overlay }).overlay).toEqual(overlay);
  });

  test('an explicitly preserved label is not stripped', () => {
    const labels = labelPolicy(['preserve label: @backonshii']);
    expect(compile(2, { copy: '@backonshii', labels }).overlay.text).toBe('@backonshii');
  });

  test('the watermark the scene states is not drawn while the removal list forbids it', () => {
    const c = compile(2);
    expect(SLIDES[2]!.scene).toContain('watermark');
    expect(c.compiledScene).not.toMatch(/watermark|Back on my/i);
    expect(c.compiledScene).toContain('cherry tomatoes.');
    expect(forbidden(contractChecks(c))).toContain('platform watermarks');
  });

  test('a scene with no mark phrase is left byte-identical', () => {
    // Only the casting rewrite ("a patchy beard" -> the target) differs from the saved scene.
    expect(compile(1).compiledScene).toBe(SLIDES[1]!.scene.replace('a patchy beard', 'patchy beard'));
  });
});

describe('appearance parser on a 2x2 collage', () => {
  test('a quadrant label is never the subject\'s wardrobe', () => {
    for (const i of [0, 1, 2]) {
      const scene = SLIDES[i]!.scene;
      expect(appearanceSpans(scene, 'wardrobe', subjectScope(scene, i === 2 ? 'Chad' : i === 1 ? 'Sub 3' : 'Sub 5'))).toEqual([]);
      expect(compile(i).subject.lockedAttributes.find(l => l.attribute === 'wardrobe')!.observed).toBeNull();
    }
    expect(contractChecks(compile(0)).join('\n')).not.toContain('Top-left');
  });

  test('a real top is still wardrobe', () => {
    expect(appearanceSpans('a man in a black top and jeans', 'wardrobe').map(s => s.text)).toEqual(['a black top']);
    expect(appearanceSpans('Top-right: a man in a grey t-shirt', 'wardrobe').map(s => s.text)).toEqual(['a grey t-shirt']);
  });

  test('complexion keeps its qualifier', () => {
    const scene = SLIDES[1]!.scene;
    expect(appearanceSpans(scene, 'complexion', subjectScope(scene, 'Sub 3')).map(s => s.text)).toEqual(['oily skin']);
    expect(compile(1).subject.lockedAttributes.find(l => l.attribute === 'complexion')!.observed).toBe('oily skin');
  });
});

describe('hair grammar without the word hair', () => {
  test('"blonde part" in the saved Chad clause is hair', () => {
    expect(parseCastingRequest('sharp jaw, blonde part, light stubble and blue eyes').targets).toEqual([
      { attribute: 'hair', value: 'blonde part' },
      { attribute: 'facial-hair', value: 'light stubble' },
      { attribute: 'eyes', value: 'blue eyes' },
    ]);
  });

  test('it reaches the contract, replaces the scene\'s own style phrase, and is checked', () => {
    const c = compile(2);
    expect(c.subject.castingTarget.hair).toBe('blonde part');
    expect(c.subject.supersededPhrases).toContain('blonde side part');
    expect(c.compiledScene).not.toContain('blonde side part');
    expect(contractChecks(c)).toContain("the subject's hair matches the requested casting target: blonde part");
  });

  test('other style words resolve, and ordinary uses of "part" do not', () => {
    expect(parseCastingRequest('side part').targets).toEqual([{ attribute: 'hair', value: 'side part' }]);
    expect(parseCastingRequest('quiff').targets).toEqual([{ attribute: 'hair', value: 'quiff' }]);
    expect(parseCastingRequest('a black part of the plate').targets).toEqual([]);
    expect(parseCastingRequest('part of the set').targets).toEqual([]);
  });
});

describe('terminal QA diagnostics', () => {
  const check = (check: string, status: 'pass' | 'fail' | 'unknown') => ({ check, status } as const);

  test('the slide error names the failing checks and the unknown count', () => {
    const msg = qaTerminalMessage({
      verdict: 'fail',
      reasons: ['eyes cannot be hazel in a B&W line drawing'],
      checks: [
        check("the subject's eyes matches the requested casting target: hazel eyes", 'fail'),
        check("the subject's hair is unchanged from the reference frame", 'unknown'),
        check("the subject's gaze is unchanged from the reference frame", 'unknown'),
        check('the medium is collage', 'pass'),
      ],
    });
    expect(msg.startsWith('story_check_failed:eyes cannot be hazel in a B&W line drawing')).toBe(true);
    expect(msg).toContain('failed(1/4): eyes matches the requested casting target: hazel eyes');
    expect(msg).toContain('unknown=2/4');
    expect(msg.length).toBeLessThan(400);
  });

  test('an unverified outcome keeps its prefix, and a bare verdict keeps the old text', () => {
    expect(qaTerminalMessage({ verdict: 'error', reasons: ['qa_missing_checks'], checks: [] })).toBe('story_unverified:qa_missing_checks');
    expect(qaTerminalMessage({ verdict: 'fail', reasons: [], checks: [] })).toBe('story_check_failed:contract_mismatch');
  });

  test('a terminal QA verdict is labelled non-retryable; a checker transport error is not', () => {
    expect(isTerminalQaError('provider_result_rejected:story_check_failed:eyes cannot be hazel')).toBe(true);
    expect(isTerminalQaError('provider_result_rejected:story_unverified:several locks are null')).toBe(true);
    expect(isTerminalQaError('provider_outcome_unknown:story_unverified:story_check_error:The operation timed out.')).toBe(false);
    expect(isTerminalQaError('provider_outcome_unknown:timeout')).toBe(false);
    expect(isTerminalQaError(undefined)).toBe(false);
  });

  test('the retry affordance marks terminal jobs and does not offer to price them', () => {
    const task = (id: string, error: string) => ({ id, kind: 'slide', target: 'v1', index: 0, status: 'failed', attempts: 1, charged: 0, error });
    const e = {
      id: 'e', status: 'failed', error: null, creditsCharged: 0, maxCredits: 100, inputs: [], report: null, variants: [], slideCount: 3,
      tasks: [task('t-qa', 'provider_result_rejected:story_check_failed:eyes cannot be hazel'), task('t-net', 'provider_outcome_unknown:timeout')],
    } as unknown as Experiment;
    const rows = experimentProgress(e).retryableJobs;
    expect(rows.find(r => r.id === 't-qa')).toMatchObject({ terminalQa: true });
    expect(rows.find(r => r.id === 't-qa')!.advice).toContain('Not retryable as-is');
    expect(rows.find(r => r.id === 't-net')).toMatchObject({ terminalQa: false });
    expect(rows.find(r => r.id === 't-net')).not.toHaveProperty('advice');
  });
});
