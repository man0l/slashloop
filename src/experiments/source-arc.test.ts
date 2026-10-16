// SLA-809: the source's own visible change (a face morphing down a tier ladder, a neck
// thickening, a room getting tidier) is read from the frames into the contract, and the
// renderer and QA are held to its scale. Nothing here knows which format the source is.
import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_JSON_SCHEMA, arcDistance, compileQaPrompt, compileSlidePrompt, contractPromptPayload, normalizeContract, sourceArcLine, tagLocks,
  type ContractInput,
} from './resolved-contract.js';
import { universalLocks } from './source-format.js';

const slide = (o: Record<string, string> = {}) => ({ overlayText: '', arcLevel: 'none', scene: 'a scene', composition: 'centred', visibleChange: '', ...o });

const input = (o: Partial<ContractInput> = {}): ContractInput => ({
  direction: 'Same format as the source tier ladder', slideCount: 3, frameCount: 3, variables: ['hook'], mode: 'controlled', alternates: 1,
  locks: tagLocks(universalLocks('faceless'), universalLocks('faceless')), sourceDefaults: [], ...o,
});

const morph = { axis: 'tier from top to bottom', levers: ['cheek and jaw fullness', 'jaw definition', 'hair'], magnitude: 'strong', lowVsHigh: 'bottom face visibly rounder, jawline no longer visible, puffy cheeks, messy receding hair' };

const raw = (o: Record<string, unknown> = {}) => ({
  droppedSourceDefaults: [], droppedLocks: [], subject: 'person', identity: 'invented-consistent', identitySheet: 'An invented man, 25, wavy black hair, hazel eyes',
  medium: 'studio portrait photography', keepSourceImage: false, borrowSourceLook: true, arcAxis: 'tier from top to bottom',
  sourceFrameLevels: (['high', 'mid', 'low'] as const).map((level, index) => ({ index, level, showsPerson: true })),
  sourceArc: morph,
  slides: [slide({ overlayText: 'TOP', arcLevel: 'high' }), slide({ overlayText: 'MIDDLE', arcLevel: 'mid', visibleChange: 'jaw softer' }), slide({ overlayText: 'BOTTOM', arcLevel: 'low', visibleChange: 'face rounder, jaw gone' })],
  pools: [{ variable: 'hook', values: [{ value: 'Hook B', slides: [] }] }],
  ...o,
});

describe('the contract reads the source change from the frames', () => {
  test('the model is asked for sourceArc, and the visible change must match the source scale', () => {
    expect((CONTRACT_JSON_SCHEMA.properties as Record<string, unknown>).sourceArc).toBeDefined();
    expect(CONTRACT_JSON_SCHEMA.required).toContain('sourceArc');
    const guide = JSON.parse(contractPromptPayload(input())).fieldGuide as Record<string, string>;
    expect(guide.sourceArc).toContain('looking at the pixels');
    expect(guide.arcAxis).toContain('sourceArc shows one');
    expect(guide['slides[].visibleChange']).toContain('never makes the change smaller than the source shows');
  });

  test('changes are worded neutrally, because providers refuse edits that judge a body', () => {
    const guide = JSON.parse(contractPromptPayload(input())).fieldGuide as Record<string, string>;
    for (const k of ['sourceArc', 'slides[].visibleChange']) expect(guide[k]).toContain('never judging or shaming ones (fat, obese, ugly, puffy');
  });

  test('a named source change is kept; levers are trimmed and de-duplicated', () => {
    const c = normalizeContract(raw({ sourceArc: { ...morph, levers: [' jaw definition ', 'Jaw definition', '', 'hair'] } }), input());
    expect(c.sourceArc).toEqual({ ...morph, levers: ['jaw definition', 'hair'] } as never);
  });

  test('no change, an unnamed change, a missing field and a sourceless brief all resolve to no source arc', () => {
    const none = { axis: '', levers: [], magnitude: 'none', lowVsHigh: '' };
    expect(normalizeContract(raw({ sourceArc: { ...morph, magnitude: 'none' } }), input()).sourceArc).toEqual(none as never);
    expect(normalizeContract(raw({ sourceArc: { ...morph, levers: [], lowVsHigh: ' ' } }), input()).sourceArc).toEqual(none as never);
    const { sourceArc: _, ...legacy } = raw();
    expect(normalizeContract(legacy, input()).sourceArc).toEqual(none as never);
    const sourceless = normalizeContract(raw({ borrowSourceLook: false, sourceFrameLevels: [] }), input({ frameCount: 0 }));
    expect(sourceless.sourceArc).toEqual(none as never);
  });

  test('every form variable is respected: a non-story variable keeps the change in both arms, angle/slide structure may retell without it', () => {
    for (const variable of ['hook', 'character', 'visualStyle', 'caption', 'cta']) {
      const guide = JSON.parse(contractPromptPayload(input({ variables: [variable as never] }))).fieldGuide as Record<string, string>;
      expect(guide.sourceArc).toContain(`arm A and every alternate show it, and only "${variable}" differs`);
    }
    for (const variable of ['concept', 'slides']) {
      const guide = JSON.parse(contractPromptPayload(input({ variables: [variable as never] }))).fieldGuide as Record<string, string>;
      expect(guide.sourceArc).not.toContain('arm A and arm B both show it');
      expect(guide.sourceArc).toContain('only if their own story keeps that progression');
    }
  });

  test('a source change the direction does not follow is reported, not silently lost', () => {
    const c = normalizeContract(raw({ arcAxis: '', slides: [slide({ overlayText: 'a' }), slide(), slide()] }), input());
    expect(c.issues.join(' ')).toContain('The source frames show "tier from top to bottom"');
  });
});

describe('the identity chain may change the face along the arc', () => {
  const c = normalizeContract(raw(), input());

  test('distance from the first slide drives how much of the source change is asked for', () => {
    expect(c.slides.map(s => arcDistance(c, s))).toEqual([0, 1, 2]);
    expect(sourceArcLine(c, c.slides[2]!, 'anchor-edit')).toContain('show at least that whole difference');
    expect(sourceArcLine(c, c.slides[1]!, 'anchor-edit')).toContain('about half of that difference');
    expect(sourceArcLine(c, c.slides[0]!, 'anchor-edit')).toBe('');
  });

  test('an arc edit keeps the identity, not the face shape and build', () => {
    const p = compileSlidePrompt(c, 2, 'anchor-edit', 'none');
    expect(p).not.toContain('Keep the same person: face, hair, skin, jewelry, build');
    expect(p).toContain('keep them recognisable (ethnicity, eye colour, hair colour, age, unless the change below names one)');
    expect(p).toContain('do not hold shape, proportions, fullness, definition or texture fixed');
    expect(p).toContain('SOURCE CHANGE: the source carousel moves its subject along "tier from top to bottom" by changing cheek and jaw fullness, jaw definition, hair');
    expect(p).toContain(morph.lowVsHigh);
    expect(p).toContain('Change ONLY this: face rounder, jaw gone');
  });

  test('a slide at the first slide\'s arc point, or a deck without an arc, keeps the old full lock', () => {
    const same = normalizeContract(raw({ slides: [slide({ overlayText: 'a', arcLevel: 'high' }), slide({ arcLevel: 'high' }), slide({ arcLevel: 'low', visibleChange: 'x' })] }), input());
    expect(compileSlidePrompt(same, 1, 'anchor-edit', 'none')).toContain('Keep the same person: face, hair, skin, jewelry, build');
    const flat = normalizeContract(raw({ arcAxis: '', sourceArc: undefined }), input());
    const p = compileSlidePrompt(flat, 1, 'anchor-edit', 'none');
    expect(p).toContain('Keep the same person: face, hair, skin, jewelry, build');
    expect(p).not.toContain('SOURCE CHANGE');
  });

  test('the form\'s locked constraints reach the identity chain and win over the source change', () => {
    const locked = normalizeContract(raw(), input({ locks: tagLocks([...universalLocks('faceless'), 'Keep the same hairstyle on every slide'], universalLocks('faceless')) }));
    const p = compileSlidePrompt(locked, 2, 'anchor-edit', 'none');
    expect(p).toContain('HARD RULES (they win over the change and the source change above):');
    expect(p).toContain('- Keep the same hairstyle on every slide');
    expect(compileSlidePrompt(locked, 0, 'anchor-edit', 'none')).not.toContain('HARD RULES');
  });

  test('the source change is a constant between arms; only the tested variable differs', () => {
    const guide = JSON.parse(contractPromptPayload(input({ variables: ['character'] }))).fieldGuide as Record<string, string>;
    expect(guide.sourceArc).toContain('arm A and every alternate show it, and only "character" differs between them');
    expect(guide['slides[].visibleChange']).toContain('a lock keeps that property fixed or forbids it');
    expect(guide['slides[].visibleChange']).toContain('never stops the subject changing along the arc inside one deck');
  });

  test('a character keeps its design and art style while it changes', () => {
    const ch = normalizeContract(raw({ subject: 'character' }), input());
    const p = compileSlidePrompt(ch, 2, 'anchor-edit', 'none');
    expect(p).toContain('keep the character recognisable and the art style');
    expect(p).toContain('alters the character itself');
  });

  test('fresh renders on an arc carry the source scale for their own point', () => {
    expect(compileSlidePrompt(c, 0, 'fresh', 'none')).toContain('This image is the HIGH (best / latest) point: show the subject in that state at the source\'s scale.');
    const noArc = normalizeContract(raw({ sourceArc: { ...morph, magnitude: 'none' } }), input());
    expect(compileSlidePrompt(noArc, 0, 'fresh', 'none')).not.toContain('SOURCE CHANGE');
  });

  test('kept source photos never get a source-change line', () => {
    expect(compileSlidePrompt(c, 1, 'edit', 'edit')).not.toContain('SOURCE CHANGE');
  });
});

describe('QA holds the deck to the source scale', () => {
  test('a progression smaller than the source fails the arc check, and changing along the arc is not identity drift', () => {
    const c = normalizeContract(raw(), input());
    const p = compileQaPrompt(c, { slideCount: 3, sourceImages: 1, referenceUse: 'none' });
    expect(p).toContain('Answer false also when the change is clearly smaller than the source\'s, which is a strong change');
    expect(p).toContain('changing along "tier from top to bottom" is expected');
  });

  test('without a source arc the QA prompt is unchanged', () => {
    const c = normalizeContract(raw({ sourceArc: undefined }), input());
    expect(compileQaPrompt(c, { slideCount: 3, sourceImages: 1, referenceUse: 'none' })).not.toContain('clearly smaller than the source');
  });
});
