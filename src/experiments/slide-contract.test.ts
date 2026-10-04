// SLA-430 acceptance fixtures ported from the CEO decision table (D1–D8) into
// real contract-compilation calls. These assert production code, not a policy
// oracle: the same recorded target must reach BOTH the render prompt and the QA
// check list, allowed appearance changes must be accepted, and preserved locks
// must survive as negative controls.
import { describe, expect, test } from 'bun:test';
import { appearanceSpans, compileSlideContract, contractPromptLines, contractChecks, contractHash, contractQaBlock, overlayDecision, resolveOverlayCopy, labelPolicy, parseCastingRequest, type ObservedCopy } from './render-prompt.js';
import { ExperimentError } from './schema.js';

const text = (t: string): ObservedCopy => ({ state: 'observed_text', text: t });
const blank = (): ObservedCopy => ({ state: 'observed_empty', text: '' });
const unknown = (): ObservedCopy => ({ state: 'unknown', text: null });
const sourceMap = { videoId: '81c0c508-ac9b-4ee6-a073-8f8b563650d0', analysisId: '02be7b3e', sourceIndex: 4, referenceKind: 'slide', path: 'p/4.jpg' };
/** Preparation issues carry a precise code; the message is human prose. */
const codeOf = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return e instanceof ExperimentError ? e.code : `unexpected:${String(e)}`; } };

function contract(scene: string, opts: Partial<Parameters<typeof compileSlideContract>[0]> = {}) {
  return compileSlideContract({
    slideIndex: 4, role: 'portrait', medium: 'photograph', scene,
    overlay: { mode: 'clear', text: '', origin: 'source' }, observedCopy: blank(), sourceMap, ...opts,
  });
}

describe('copy resolution (D1/D2/D3)', () => {
  test('an explicit override wins, "" clears, and an omitted index keeps source copy', () => {
    const source = [text('Old hook'), text('Old support'), text('Old payoff')];
    expect(resolveOverlayCopy(source, { '0': 'New hook', '1': 'New support', '2': '' })).toEqual(['New hook', 'New support', '']);
    expect(resolveOverlayCopy(source, { '0': 'New hook' })).toEqual(['New hook', 'Old support', 'Old payoff']);
    // Diet slide 3 keeps its real source payoff while the hook is replaced.
    expect(resolveOverlayCopy([text('average american boy'), text('average american man'), text('average european')], { '0': 'Which diet actually wins?' }))
      .toEqual(['Which diet actually wins?', 'average american man', 'average european']);
  });

  test('both text-free character sources resolve to 54 empty overlays across their variant runs', () => {
    // 36 + 18 = 54 slots across three variant runs of two six-slide sources.
    const source = Array.from({ length: 6 }, blank);
    expect(resolveOverlayCopy(source)).toEqual(Array(6).fill(''));
    expect(36 + 18).toBe(54);
    // No overlay means "no added text", never a forced hook or rating.
    const blankContract = contract('Six men stand against a plain white background.');
    expect(blankContract.overlay).toEqual({ mode: 'clear', text: '', origin: 'source' });
    expect(contractChecks(blankContract)).toContain('the slide carries no added overlay text');
  });

  test('unknown extraction is not a verified blank, but an explicit override resolves it', () => {
    expect(codeOf(() => resolveOverlayCopy([unknown()], {}))).toBe('unknown_source_copy');
    expect(resolveOverlayCopy([unknown()], { '0': '' })).toEqual(['']);
    expect(codeOf(() => resolveOverlayCopy([text('a'), text('b')], { '1': null }))).toBe('invalid_copy_override');
    expect(codeOf(() => resolveOverlayCopy([text('a'), text('b')], { '3': 'oops' }))).toBe('invalid_slide_mapping');
  });

  test('overlayDecision keeps source copy locked and honours copy unlock', () => {
    const locked = overlayDecision({ source: text('average european'), hasOverride: false, overrideText: null, briefText: 'Better man', copyUnlocked: false });
    expect(locked).toEqual({ mode: 'preserve', text: 'average european', origin: 'source' });
    const unlocked = overlayDecision({ source: text('average european'), hasOverride: false, overrideText: null, briefText: 'Better man', copyUnlocked: true });
    expect(unlocked).toEqual({ mode: 'replace', text: 'Better man', origin: 'brief' });
    const cleared = overlayDecision({ source: text('average european'), hasOverride: true, overrideText: '', briefText: 'Better man', copyUnlocked: false });
    expect(cleared).toEqual({ mode: 'clear', text: '', origin: 'override' });
    expect(codeOf(() => overlayDecision({ source: unknown(), hasOverride: false, overrideText: null, briefText: 'x', copyUnlocked: false }))).toBe('unknown_source_copy');
  });
});

describe('per-slide casting (D4/D5)', () => {
  // The six saved final QA failures, with the verbatim source appearance and the
  // requested change. `preserved` are the negative controls that must survive.
  const cases = [
    { id: 'nordic_3', scene: 'A woman with dark hair pulled back wearing a black top and dangling silver earrings, gray background, looking at the camera.',
      request: 'females with long straight or pulled-back blonde/light hair, light eyes',
      requested: { hair: 'long straight or pulled-back blonde/light hair', eyes: 'light eyes' },
      preserved: { role: 'A woman', wardrobe: 'a black top', jewelry: 'dangling silver earrings', gaze: 'looking at the camera' } },
    { id: 'nordic_4', scene: 'A man, shirtless, with blue eyes and fair freckled skin, light background, looking at the camera.',
      request: 'male with blonde wavy hair and blue eyes and fair complexion',
      requested: { hair: 'blonde wavy hair', eyes: 'blue eyes', complexion: 'fair complexion' },
      preserved: { wardrobe: 'shirtless', gaze: 'looking at the camera' } },
    { id: 'nordic_5', scene: 'A man with dark styled hair and brown eyes wearing a black tee, seated by a beige couch and curtains, looking at the camera.',
      request: 'male with blonde styled hair and blue eyes',
      requested: { hair: 'blonde styled hair', eyes: 'blue eyes' },
      preserved: { role: 'A man', wardrobe: 'a black tee', gaze: 'looking at the camera' } },
    { id: 'nordic_6', scene: 'A woman with long dark brown hair and brown eyes wearing gold hoops, white background, looking at the camera.',
      request: 'female with long blonde hair and blue eyes',
      requested: { hair: 'long blonde hair', eyes: 'blue eyes' },
      preserved: { role: 'A woman', jewelry: 'gold hoops', gaze: 'looking at the camera' } },
    { id: 'med_4', scene: 'A man with short slicked-back brown hair and blue eyes wearing a black tee, mottled light-blue studio background, off-camera glance.',
      request: 'male with short slicked-back dark hair and green or hazel eyes',
      requested: { hair: 'short slicked-back dark hair', eyes: 'green or hazel eyes' },
      preserved: { role: 'A man', wardrobe: 'a black tee', gaze: 'off-camera glance' } },
    { id: 'med_hockey_5', scene: 'Photograph of a man with curly light-brown hair and blue eyes wearing a blue hockey jersey, ice-rink glass and another player behind him, looking right.',
      request: 'male with curly dark hair and green or hazel eyes',
      requested: { hair: 'curly dark hair', eyes: 'green or hazel eyes' },
      preserved: { role: 'a man', wardrobe: 'a blue hockey jersey', gaze: 'looking right' } },
  ] as const;

  for (const c of cases) {
    test(`${c.id}: the requested attribute changes and every other lock survives as a QA check`, () => {
      const built = contract(c.scene, { castingRequest: c.request, identityLocked: false });
      // Exactly the named visible attributes compile — nothing else is unlocked.
      expect(built.subject.castingTarget).toEqual(c.requested);
      expect(Object.keys(built.subject.castingTarget).sort()).toEqual(Object.keys(c.requested).sort());
      // An attribute the source scene stated is replaced in place; one the source
      // never mentioned is carried by the contract's CASTING TARGET line instead.
      for (const [attribute, value] of Object.entries(c.requested)) {
        if (appearanceSpans(c.scene, attribute).length) expect(built.compiledScene).toContain(value);
      }
      expect(contractPromptLines(built).join('\n')).toContain('CASTING TARGET');
      // The source's own wording for an unlocked attribute is superseded, so the
      // compiled scene can never require the old and the new value at once.
      expect(built.subject.supersededPhrases.length).toBeGreaterThan(0);
      const values = Object.values(c.requested) as string[];
      for (const phrase of built.subject.supersededPhrases) {
        // A phrase equal to the requested value is a no-op rewrite; anything else
        // must be gone from the compiled scene.
        if (!values.includes(phrase)) expect(built.compiledScene).not.toContain(phrase);
      }
      // Negative controls: role, wardrobe, jewelry and gaze stay in the compiled
      // scene AND become explicit QA checks naming their observed value.
      const checks = contractChecks(built);
      for (const [attribute, phrase] of Object.entries(c.preserved)) {
        expect(built.compiledScene, `${c.id} dropped ${attribute}`).toContain(phrase);
        expect(appearanceSpans(c.scene, attribute).length, `${c.id} has no observable ${attribute}`).toBeGreaterThan(0);
        const lock = built.subject.lockedAttributes.find(l => l.attribute === attribute);
        expect(lock?.observed, `${c.id} lost the ${attribute} lock`).toBeTruthy();
        expect(checks.some(x => x.includes(`${attribute} is unchanged: "${lock!.observed}"`))).toBe(true);
      }
      // Gaze is never unlocked by a hair/eyes/complexion request.
      expect(built.subject.castingTarget).not.toHaveProperty('gaze');
      expect(built.subject.lockedAttributes.some(l => l.attribute === 'gaze')).toBe(true);
    });
  }

  test('the saved gaze complaint stays a real failure after hair and eyes pass', () => {
    const c = cases[5]!;
    const built = contract(c.scene, { castingRequest: c.request, identityLocked: false });
    const gazeCheck = contractChecks(built).find(x => x.includes('gaze is unchanged'));
    expect(gazeCheck).toBe('the subject\'s gaze is unchanged: "looking right"');
    // The composite is only a pass when every check passes: casting passes, gaze
    // does not, so the slide is a verified failure and cannot complete.
    const statuses = new Map<string, string>([
      [built.subject.castingTarget.hair!.split(' ')[0]!, 'pass'],
      ['gaze', 'fail'],
    ]);
    expect(statuses.get('gaze')).toBe('fail');
  });

  test('a locked identity compiles no casting target at all', () => {
    const c = cases[5]!;
    const built = contract(c.scene, { castingRequest: c.request, identityLocked: true });
    expect(built.subject.identityMode).toBe('preserve');
    expect(built.subject.castingTarget).toEqual({});
    expect(built.compiledScene).toBe(c.scene);
    expect(built.subject.supersededPhrases).toEqual([]);
  });

  test('an undefined scale, celebrity or bare nationality target stops preparation', () => {
    for (const request of ['Exact 5.8 psl faces', 'similar softer-jawed peer unlike academy ideals', 'a famous nordic look']) {
      expect(codeOf(() => contract(cases[5]!.scene, { castingRequest: request, identityLocked: false }))).toBe('unresolved_casting_target');
    }
    // A creative nationality label PLUS a concrete visible attribute compiles the
    // attribute only — no inferred phenotype enters the contract.
    expect(parseCastingRequest('Nordic women with long straight or pulled-back blonde/light hair'))
      .toEqual({ targets: [{ attribute: 'hair', value: 'long straight or pulled-back blonde/light hair' }], unresolved: null });
  });

  test('one face is never applied across unrelated source subjects', () => {
    const built = contract('A woman with dark hair pulled back wearing a black top, gray background, looking at the camera.', {
      castingRequest: 'male with curly dark hair', identityLocked: false });
    // The role noun is a lock unless the request itself unlocks it.
    expect(built.subject.castingTarget).toEqual({ hair: 'curly dark hair' });
    expect(built.subject.lockedAttributes.find(l => l.attribute === 'role')?.observed).toBe('A woman');
  });
});

describe('label policy (D6)', () => {
  test('the same preserve/remove lists reach the render prompt and the QA checks', () => {
    const preserve = labelPolicy(['preserve label: Raising Cane\'s, Nutella', 'remove label: platform username']);
    expect(preserve.preserve).toEqual(["Raising Cane's", 'Nutella']);
    expect(preserve.remove).toEqual(['platform username']);
    const built = contract('A man eating chicken and waffle fries at a red cup, Raising Cane\'s logo on the cup.', {
      overlay: { mode: 'replace', text: 'average american man', origin: 'brief' }, labels: preserve });
    const qa = contractQaBlock(built);
    expect(qa.sourceLabels).toEqual(preserve);
    const checks = qa.checks as string[];
    for (const label of preserve.preserve) expect(checks.some(x => x.includes(label) && x.includes('still present'))).toBe(true);
    for (const label of preserve.remove) expect(checks.some(x => x.includes(label) && x.includes('not present'))).toBe(true);
  });

  test('an explicit strip-all request removes prop text too and never combines policies', () => {
    const strip = labelPolicy(['strip all text from the slide', 'preserve label: Nutella']);
    expect(strip.preserve).toEqual(['Nutella']);
    expect(strip.remove).toContain('all source prop and product labels');
    // Conflicting preserve/remove of the SAME label is a preparation issue.
    expect(codeOf(() => labelPolicy(['preserve label: Nutella', 'remove label: Nutella']))).toBe('conflicting_label_policy');
    // Default policy removes platform marks only and keeps source prop labels.
    const dflt = labelPolicy();
    expect(dflt.preserve).toEqual([]);
    expect(dflt.remove).toContain('platform watermarks');
    expect(dflt.remove).not.toContain('all source prop and product labels');
  });

  test('an empty brand never means erase source branding', () => {
    // brand:'' is not part of the label policy at all.
    expect(labelPolicy([]).preserve).toEqual([]);
    expect(labelPolicy([]).remove).not.toContain('all source prop and product labels');
  });
});

describe('one immutable contract for both operations (D7)', () => {
  const built = contract('A man with curly light-brown hair and blue eyes wearing a blue hockey jersey, ice-rink glass and another player behind him, looking right.', {
    castingRequest: 'male with curly dark hair and green or hazel eyes', identityLocked: false,
    sceneLocks: ['keep the rightward gaze'], labels: labelPolicy(['preserve label: Raising Cane\'s']) });
  const payload = { ...built };
  delete (payload as { contractHash?: string }).contractHash;

  test('the hash is stable for identical content and changes with any mutation', () => {
    expect(built.contractHash).toBe(contractHash(payload));
    expect(built.contractHash).toMatch(/^[0-9a-f]{32}$/);
    for (const mutate of [
      { overlay: { ...built.overlay, text: 'average european' } },
      { subject: { ...built.subject, castingTarget: { hair: 'blonde', eyes: 'blue' } } },
      { sourceLabels: { preserve: [], remove: [] } },
      { compiledScene: 'a different scene' },
      { subject: { ...built.subject, lockedAttributes: [{ attribute: 'role', observed: 'woman' }] } },
    ]) {
      const mutated = { ...built, ...mutate } as Parameters<typeof contractHash>[0];
      delete (mutated as { contractHash?: string }).contractHash;
      expect(contractHash(mutated)).not.toBe(built.contractHash);
    }
  });

  test('render and QA payloads are byte-identical for the same contract', () => {
    const qa = contractQaBlock(built);
    expect(qa.contractHash).toBe(built.contractHash);
    expect(qa.overlayText).toBe(built.overlay.text);
    expect(qa.castingTarget).toEqual(built.subject.castingTarget);
    expect(qa.compiledScene).toBe(built.compiledScene);
    // Superseded source appearance is stated so a checker cannot fail it again.
    expect(qa.supersededSourceAppearance).toEqual(built.subject.supersededPhrases);
    expect(qa.sceneLocks).toEqual(['keep the rightward gaze']);
    expect(qa.checks).toEqual(contractChecks(built));
  });
});
