import { describe, expect, test } from 'bun:test';
import {
  assertExactEditContractIntact,
  assertSingleVariant,
  compareOutsideMask,
  composeApprovedMask,
  compileExactEdit,
  exactEditBrief,
  exactEditSlideCompletion,
  requiredChecks,
  resolveExactOverlay,
  verifyAssetReuse,
  type Rgba,
} from './exact-edit.js';
import { prepare, prepareExactEditSlide } from './providers.js';
import { EXACT_EDIT_VARIANT_COUNT, ExperimentError, type ExactEditContract } from './schema.js';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return err instanceof ExperimentError ? err.code : `not_an_ExperimentError:${String(err)}`; }
  throw new Error('expected a failure');
};

/* Synthetic originals. These fixtures prove the ALGORITHM and the GATES only.
 * They are explicitly distinct from the historical skin/diet/character source
 * frames, which remain an unresolved source dependency (SLA-447). */
const sha = (seed: string): string => seed.padStart(4, '0').repeat(16).slice(0, 64);
const original = (sourceIndex: number, over: Record<string, unknown> = {}) => ({
  sourceIndex,
  assetRef: `workspace/vid1/slides/0${sourceIndex}.jpg`,
  original: true,
  encodedSha256: sha(String(sourceIndex)),
  dimensions: { width: 1080, height: 1920 },
  ...over,
});
const inc = (outputIndex: number, sourceIndex: number, reason = 'mapped_source_slide') => ({
  outputIndex, sourceIndex, included: true, reason,
});

/** Five-slide synthetic fixture shaped like the diet deck, with an explicit ending. */
function baseRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'exact_edit',
    contractVersion: 1,
    workspaceId: 'w1',
    videoIds: ['vid1'],
    source: { videoId: 'vid1', revision: null, revisionState: 'unknown', provenance: 'recorded source slide key; original bytes unknown' },
    inclusions: [0, 1, 2, 3, 4].map(i => inc(i, i)),
    originals: [0, 1, 2, 3, 4].map(i => original(i)),
    sourceCopy: {
      '0': { state: 'resolved', text: 'ORIGINAL OPENER' },
      '1': { state: 'resolved', text: 'step one' },
      '2': { state: 'resolved', text: 'step two' },
      '3': { state: 'resolved', text: 'day 30' },
      '4': { state: 'resolved', text: 'average european' },
    },
    locks: {
      locked: ['order', 'roles', 'aspectRatio', 'crop', 'panels', 'camera', 'medium', 'background', 'wardrobe', 'jewelry', 'expression', 'gaze'],
      unlocked: [],
    },
    labels: { allowed: ['Nutella'], removals: ['platform watermarks'] },
    ending: { choice: 'exclude', sourceIndices: [5], instruction: 'Reduced slide count; exclude the app card.' },
    maxCredits: 0,
    idempotencyKey: 'mcp:exact-edit:fixture1',
    ...over,
  };
}

describe('exact_edit dispatch shape: one deck, one variant, no selectors', () => {
  test('the operation is opt-in and versioned, and compiles to exactly one variant', () => {
    const c = compileExactEdit(baseRequest());
    expect(c.operation).toBe('exact_edit');
    expect(c.contractVersion).toBe(1);
    expect(c.variantCount).toBe(1);
    expect(c.variantCount).toBe(EXACT_EDIT_VARIANT_COUNT);
    expect(() => assertSingleVariant(c)).not.toThrow();
    // Exactly one authoritative overlay per output slide, and nothing to rank.
    expect(c.slides.map(s => s.outputIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(c)).not.toContain('candidates');
  });

  test('a legacy-shaped body cannot reach exact_edit at all', () => {
    const legacy = baseRequest();
    delete legacy.operation;
    delete legacy.contractVersion;
    expect(codeOf(() => compileExactEdit(legacy))).toBe('invalid_exact_edit_request');
    // An edit-mode body (two variants, hook variable) is not an exact_edit body either.
    expect(codeOf(() => compileExactEdit({ ...baseRequest(), variantCount: 2 }))).toBe('invalid_exact_edit_request');
  });

  test('preparation makes no service call; every slide plans reuse or one approved composite', () => {
    const contract = compileExactEdit(baseRequest());
    for (const slide of contract.slides) {
      const plan = prepareExactEditSlide({ exactEdit: contract }, slide.outputIndex);
      expect(plan.serviceCalls).toBe(0);
      expect(plan.action).toBe('reuse_original');
      expect(plan.contractHash).toBe(contract.contractHash);
      expect(plan.originalAssetRef).toBe(slide.original!.assetRef);
    }
  });

  test('the engine prepare path never reaches generateImage, classify or jevScores', async () => {
    const contract = compileExactEdit(baseRequest());
    const calls: string[] = [];
    const e: any = {
      id: 'e1', operation: { kind: 'exact_edit', contractVersion: 1 }, exactEdit: contract,
      variants: [], inputs: [], instructions: { variables: ['hook'] }, slideCount: contract.slides.length,
    };
    const render: any = {
      generateImage: async () => { calls.push('generateImage'); throw new Error('must not be called'); },
      classify: async () => { calls.push('classify'); throw new Error('must not be called'); },
      jevScores: async () => { calls.push('jevScores'); throw new Error('must not be called'); },
      generateBriefCandidates: async () => { calls.push('generateBriefCandidates'); throw new Error('must not be called'); },
    };
    const prepared = await prepare(e, { id: 't0', kind: 'slide', target: 'v0', index: 0, status: 'pending', attempts: 0, charged: 0 }, render);
    expect(prepared.free).toBe(true);
    expect(prepared.units).toBe(0);
    expect(await prepared.execute()).toMatchObject({ action: 'reuse_original', serviceCalls: 0 });
    expect(calls).toEqual([]);
  });

  test('an exact_edit row refuses briefs ranking and report planning', async () => {
    const contract = compileExactEdit(baseRequest());
    const e: any = { id: 'e1', operation: { kind: 'exact_edit', contractVersion: 1 }, exactEdit: contract, variants: [] };
    await expect(prepare(e, { id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }, {} as any)).rejects.toThrow(/exact_edit_no_planning/);
    await expect(prepare(e, { id: 't', kind: 'report', status: 'pending', attempts: 0, charged: 0 }, {} as any)).rejects.toThrow(/exact_edit_no_planning/);
  });
});

describe('copy: explicit override wins, "" clears, omission retains source copy', () => {
  test('an omitted exact-edit override keeps the resolved source copy on every slide', () => {
    const c = compileExactEdit(baseRequest());
    expect(c.slides.map(s => s.effectiveOverlayText)).toEqual(['ORIGINAL OPENER', 'step one', 'step two', 'day 30', 'average european']);
    expect(c.slides.every(s => s.overlayOrigin === 'source')).toBe(true);
    expect(c.briefHook).toBe('ORIGINAL OPENER');
  });

  test('an explicit "" clears the opener and a support slide', () => {
    const c = compileExactEdit(baseRequest({ overlayOverrides: { '0': '', '2': '' } }));
    expect(c.slides[0]!.effectiveOverlayText).toBe('');
    expect(c.slides[0]!.overlayMode).toBe('clear');
    expect(c.slides[0]!.overlayOrigin).toBe('override');
    // The slide-zero hook mirror is blank too and never falls back to source.
    expect(c.briefHook).toBe('');
    expect(c.slides[2]!.effectiveOverlayText).toBe('');
    expect(c.slides[2]!.overlayMode).toBe('clear');
    // Slides with no override keep their source copy.
    expect(c.slides[1]!.effectiveOverlayText).toBe('step one');
    expect(c.slides[4]!.effectiveOverlayText).toBe('average european');
  });

  test('an explicit blank ending is legal when requested', () => {
    const c = compileExactEdit(baseRequest({ ending: { choice: 'replace', sourceIndices: [5], replacement: { outputIndex: 4, text: '' } } }));
    expect(c.ending.choice).toBe('replace');
    expect(c.slides[4]!.effectiveOverlayText).toBe('average european');
  });

  test('exact whitespace, casing and punctuation are preserved byte for byte', () => {
    const exact = '  Average  EUROPEAN,  day 30!  ';
    const c = compileExactEdit(baseRequest({ overlayOverrides: { '0': exact } }));
    expect(c.slides[0]!.effectiveOverlayText).toBe(exact);
    expect(c.briefHook).toBe(exact);
    expect(c.overlayOverrides['0']).toBe(exact);
  });

  test('a deliberate empty string is a value, not an omission', () => {
    expect(resolveExactOverlay(baseRequest({ overlayOverrides: { '0': '' } }) as never, 0))
      .toEqual({ text: '', origin: 'override', mode: 'clear' });
    expect(resolveExactOverlay(baseRequest() as never, 0))
      .toEqual({ text: 'ORIGINAL OPENER', origin: 'source', mode: 'preserve' });
  });

  test('unresolved source copy fails preparation and never resolves to empty', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({
      sourceCopy: { ...(baseRequest().sourceCopy as Record<string, unknown>), '3': { state: 'unresolved', reason: 'analysis onScreenText was null' } },
    })))).toBe('unknown_source_copy');
  });

  test('an explicit override resolves an otherwise unresolved slide', () => {
    const c = compileExactEdit(baseRequest({
      sourceCopy: { ...(baseRequest().sourceCopy as Record<string, unknown>), '3': { state: 'unresolved' } },
      overlayOverrides: { '3': 'approved copy for a slide whose source text was unreadable' },
    }));
    expect(c.slides[3]!.effectiveOverlayText).toBe('approved copy for a slide whose source text was unreadable');
    expect(c.slides[3]!.overlayOrigin).toBe('override');
  });

  test('a blank and an unknown are distinct states, never both empty', () => {
    const blank = compileExactEdit(baseRequest({ sourceCopy: { ...(baseRequest().sourceCopy as Record<string, unknown>), '3': { state: 'resolved', text: '' } } }));
    expect(blank.slides[3]!.effectiveOverlayText).toBe('');
    expect(blank.slides[3]!.overlayOrigin).toBe('source');
    expect(blank.slides[3]!.overlayMode).toBe('clear');
    expect(codeOf(() => compileExactEdit(baseRequest({
      sourceCopy: { ...(baseRequest().sourceCopy as Record<string, unknown>), '3': { state: 'unresolved' } },
    })))).toBe('unknown_source_copy');
  });

  test('a hook mirror contradicting slide zero fails before execution; a blank mirror agrees', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({ hookMirror: 'SOMETHING ELSE' })))).toBe('hook_overlay_conflict');
    expect(() => compileExactEdit(baseRequest({ overlayOverrides: { '0': '' }, hookMirror: '' }))).not.toThrow();
  });
});

describe('source preservation, originals and mapping', () => {
  test('every unchanged included slide reuses the pinned original reference', () => {
    const c = compileExactEdit(baseRequest());
    for (const s of c.slides) {
      expect(s.reuseOriginal).toBe(true);
      expect(s.original!.original).toBe(true);
      expect(s.original!.encodedSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(c.source.revisionState).toBe('unknown');
    expect(c.source.revision).toBeNull();
  });

  test('a missing original for an included slide stops preparation', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({ originals: [0, 1, 2, 3].map(i => original(i)) })))).toBe('invalid_exact_edit_request');
  });

  test('a generated or recreated frame cannot pose as the original', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({
      originals: [0, 1, 2, 3, 4].map(i => original(i, { original: false })),
    })))).toBe('invalid_exact_edit_request');
    // Present-but-not-original is refused even when a hash exists.
    expect(codeOf(() => compileExactEdit(baseRequest({
      originals: [4, 3, 2, 1].map(i => original(i, { original: false })),
    })))).toBe('invalid_exact_edit_request');
  });

  test('no reference rotation, no inferred dropped slide, no deck padding', () => {
    // A gap in the ordered output map is refused rather than padded.
    expect(codeOf(() => compileExactEdit(baseRequest({
      inclusions: [inc(0, 0), inc(1, 1), inc(3, 2)],
      originals: [0, 1, 2].map(i => original(i)),
    })))).toBe('invalid_exact_edit_request');
    // One source slide feeding two output slides is rotation, and is refused.
    expect(codeOf(() => compileExactEdit(baseRequest({
      inclusions: [inc(0, 0), inc(1, 0)],
      originals: [0, 1].map(i => original(i)),
    })))).toBe('invalid_exact_edit_request');
    // Output order follows the explicit map, not the source index order.
    const reordered = compileExactEdit(baseRequest({
      inclusions: [inc(1, 0, 'lead'), inc(0, 1, 'opener')],
      originals: [0, 1].map(i => original(i)),
      sourceCopy: { '0': { state: 'resolved', text: 'opener' }, '1': { state: 'resolved', text: 'lead' } },
    }));
    expect(reordered.slides.map(s => s.outputIndex)).toEqual([0, 1]);
    expect(reordered.slides[0]!.sourceIndex).toBe(1);
    expect(reordered.briefHook).toBe('opener');
  });

  test('an invented source revision is refused; a known revision must carry its value', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({
      source: { videoId: 'vid1', revision: 'rev-1', revisionState: 'unknown', provenance: 'p' },
    })))).toBe('invalid_exact_edit_request');
    expect(codeOf(() => compileExactEdit(baseRequest({
      source: { videoId: 'vid1', revision: null, revisionState: 'known', provenance: 'p' },
    })))).toBe('invalid_exact_edit_request');
    expect(compileExactEdit(baseRequest({
      source: { videoId: 'vid1', revision: 'rev-7', revisionState: 'known', provenance: 'p' },
    })).source.revision).toBe('rev-7');
  });

  test('the contract hash is stable, and every field mutation invalidates it', () => {
    const a = compileExactEdit(baseRequest());
    const b = compileExactEdit(baseRequest());
    expect(a.contractHash).toBe(b.contractHash);
    expect(a.canonicalSha256).toBe(b.canonicalSha256);
    expect(a.contractHash).toMatch(/^[0-9a-f]{32}$/);
    for (const changed of [
      baseRequest({ overlayOverrides: { '0': 'different' } }),
      baseRequest({ ending: { choice: 'exclude', sourceIndices: [5], instruction: 'different words' } }),
      baseRequest({ labels: { allowed: [], removals: ['platform watermarks'] } }),
      baseRequest({ locks: { locked: ['order'], unlocked: ['gaze'] } }),
    ]) {
      expect(compileExactEdit(changed).contractHash).not.toBe(a.contractHash);
    }
  });

  test('a mutated stored contract is detected before it can drive a render or a check', () => {
    const c = compileExactEdit(baseRequest());
    const tampered = structuredClone(c);
    tampered.slides[1]!.effectiveOverlayText = 'quietly rewritten';
    expect(codeOf(() => assertExactEditContractIntact(tampered))).toBe('exact_edit_contract_mutated');
    expect(() => assertExactEditContractIntact(c)).not.toThrow();
  });

  test('the effective brief, the compositor and QA all bind to one hash and overlay', () => {
    const c = compileExactEdit(baseRequest({ overlayOverrides: { '0': 'NEW OPENER', '2': '' } }));
    const brief = exactEditBrief(c);
    expect(brief.contractHash).toBe(c.contractHash);
    expect(brief.hook).toBe('NEW OPENER');
    expect(brief.variantCount).toBe(1);
    for (const s of c.slides) {
      const briefSlide = brief.slides.find(x => x.index === s.outputIndex)!;
      expect(briefSlide.overlayText).toBe(s.effectiveOverlayText);
      const plan = prepareExactEditSlide({ exactEdit: c }, s.outputIndex);
      expect(plan.contractHash).toBe(brief.contractHash);
      expect(plan.overlayText).toBe(briefSlide.overlayText);
      expect(requiredChecks(c, s.outputIndex)).toContain(`the on-image overlay matches exactly: ${JSON.stringify(s.effectiveOverlayText)}`);
    }
  });
});

describe('labels and the mandatory ending choice', () => {
  test('a label allowed and removed at once stops preparation', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({
      labels: { allowed: ['Nutella', "Raising Cane's"], removals: ['Nutella'] },
    })))).toBe('invalid_exact_edit_request');
  });

  test('allowed labels reach QA as keep-checks, removals as absence-checks', () => {
    const c = compileExactEdit(baseRequest({ labels: { allowed: ['Nutella', "Raising Cane's"], removals: ['platform watermarks'] } }));
    const checks = requiredChecks(c, 2);
    expect(checks).toContain('the source label "Nutella" is still present, in its original position');
    expect(checks).toContain('the source label "Raising Cane\'s" is still present, in its original position');
    expect(checks).toContain('the mark "platform watermarks" is not present anywhere on the slide');
  });

  test('all three ending choices compile and each asserts its own check', () => {
    const retain = compileExactEdit(baseRequest({ ending: { choice: 'retain', sourceIndices: [5], appCardException: true } }));
    expect(requiredChecks(retain, 4)).toContain('the source ending at index 5 is retained verbatim');
    expect(requiredChecks(retain, 4)).toContain('the retained source app card is preserved as supplied, with no invented UI or claims');
    const replace = compileExactEdit(baseRequest({ ending: { choice: 'replace', sourceIndices: [5], replacement: { outputIndex: 4, text: 'APPROVED ENDING COPY' } } }));
    expect(requiredChecks(replace, 4)).toContain('the ending copy is exactly "APPROVED ENDING COPY" at output slide 4');
    expect(requiredChecks(replace, 4)).toContain('no app feature, claim or branding was invented in the ending');
    const exclude = compileExactEdit(baseRequest());
    expect(requiredChecks(exclude, 4)).toContain('no content from source index 5 appears');
  });

  test('the historical reduced-slide exclusion records its instruction and indices', () => {
    expect(compileExactEdit(baseRequest()).ending).toEqual({
      choice: 'exclude', sourceIndices: [5], instruction: 'Reduced slide count; exclude the app card.',
    });
  });

  test('a missing ending choice is never defaulted', () => {
    const r = baseRequest();
    delete r.ending;
    // Preparation fails with its own precise code, not a generic schema error.
    expect(codeOf(() => compileExactEdit(r))).toBe('missing_ending_choice');
  });

  test('no foreign ending text appears on an unresolved or blank character ending', () => {
    // "average european" survives only where the source transcription supports it.
    expect(compileExactEdit(baseRequest()).slides[4]!.effectiveOverlayText).toBe('average european');
    // An unresolved ending source cannot silently resolve to that string.
    expect(codeOf(() => compileExactEdit(baseRequest({
      sourceCopy: { ...(baseRequest().sourceCopy as Record<string, unknown>), '4': { state: 'unresolved' } },
    })))).toBe('unknown_source_copy');
    // With the ending slide out of the map entirely, no default appears.
    const noEndingSlide = compileExactEdit(baseRequest({
      inclusions: [0, 1, 2, 3].map(i => inc(i, i)),
      originals: [0, 1, 2, 3].map(i => original(i)),
      ending: { choice: 'exclude', sourceIndices: [4], instruction: 'Exclude the ending source frame.' },
    }));
    expect(noEndingSlide.slides.map(s => s.effectiveOverlayText)).not.toContain('average european');
    expect(noEndingSlide.ending.choice).toBe('exclude');
  });
});

describe('character targets retain contrasts, roles, gaze and wardrobe', () => {
  const characterRequest = (over: Record<string, unknown> = {}) => baseRequest({
    characters: [{
      outputIndex: 1, subjectId: 'subject-a',
      visibleTarget: 'short dark curls and brown eyes',
      approvedReferenceRef: null,
      retained: ['role', 'layout', 'gaze', 'wardrobe', 'jewelry'],
      narrativeContrast: 'week-1 skin before the routine starts',
    }],
    ...over,
  });

  test('a per-subject target keeps every retained property as an explicit check', () => {
    const c = compileExactEdit(characterRequest());
    const checks = requiredChecks(c, 1);
    for (const r of ['role', 'layout', 'gaze', 'wardrobe', 'jewelry']) {
      expect(checks).toContain(`the subject's ${r} is unchanged from the original reference`);
    }
    expect(checks).toContain("the subject's requested visible target is present: short dark curls and brown eyes");
    expect(checks).toContain('the source narrative contrast is preserved: week-1 skin before the routine starts');
    // Sequence integrity: one subject's face is never reused on another slide.
    expect(checks).toContain("this slide's subject is not another subject's face");
  });

  test('hair and eyes passing never unlock gaze: dropping gaze from retained fails', () => {
    expect(codeOf(() => compileExactEdit(characterRequest({
      characters: [{
        outputIndex: 1, subjectId: 'subject-a', visibleTarget: 'short dark curls and brown eyes',
        retained: ['role', 'layout', 'wardrobe', 'jewelry'],
        narrativeContrast: 'week-1 skin',
      }],
    })))).toBe('character_lock_violation');
  });

  test('re-role or re-layout is refused', () => {
    expect(codeOf(() => compileExactEdit(characterRequest({
      characters: [{
        outputIndex: 1, subjectId: 'subject-a', visibleTarget: 'short dark curls',
        retained: ['gaze', 'wardrobe', 'jewelry'],
      }],
    })))).toBe('character_lock_violation');
  });

  test('an undefined attractiveness score or bare nationality label stays unresolved', () => {
    for (const target of ['8.2 psl faces', 'looks european', 'looks like a celebrity']) {
      expect(codeOf(() => compileExactEdit(characterRequest({
        characters: [{
          outputIndex: 1, subjectId: 'subject-a', visibleTarget: target,
          retained: ['role', 'layout', 'gaze', 'wardrobe'],
        }],
      })))).toBe('unresolved_casting_target');
    }
    // An approved reference instead of prose is a valid target.
    expect(() => compileExactEdit(characterRequest({
      characters: [{
        outputIndex: 1, subjectId: 'subject-a', visibleTarget: null,
        approvedReferenceRef: 'workspace/vid1/references/subject-a.jpg',
        retained: ['role', 'layout', 'gaze', 'wardrobe'],
      }],
    }))).not.toThrow();
  });

  test('a character target without a visible target or approved reference is ambiguous', () => {
    expect(codeOf(() => compileExactEdit(characterRequest({
      characters: [{ outputIndex: 1, subjectId: 'subject-a', retained: ['role', 'layout', 'gaze', 'wardrobe'] }],
    })))).toBe('unresolved_casting_target');
  });

  test('two targets naming one slide, or an excluded slide, are refused', () => {
    expect(codeOf(() => compileExactEdit(characterRequest({
      characters: [
        { outputIndex: 1, subjectId: 'a', visibleTarget: 'dark curls', retained: ['role', 'layout', 'gaze'] },
        { outputIndex: 1, subjectId: 'b', visibleTarget: 'blonde waves', retained: ['role', 'layout', 'gaze'] },
      ],
    })))).toBe('invalid_exact_edit_request');
    expect(codeOf(() => compileExactEdit(characterRequest({
      inclusions: [0, 1, 2].map(i => inc(i, i)),
      originals: [0, 1, 2].map(i => original(i)),
      characters: [{ outputIndex: 4, subjectId: 'a', visibleTarget: 'dark curls', retained: ['role', 'layout', 'gaze'] }],
    })))).toBe('invalid_exact_edit_request');
  });

  test('character fidelity stays unverified without originals and stays off the paid path', () => {
    const c = compileExactEdit(characterRequest());
    const plan = prepareExactEditSlide({ exactEdit: c }, 1);
    // Reuse, never a paid character render: the source frame is authoritative.
    expect(plan.action).toBe('reuse_original');
    expect(plan.serviceCalls).toBe(0);
    const outcomes = requiredChecks(c, 1).map(check => ({ outputIndex: 1, check, status: 'unavailable' as const }));
    const completion = exactEditSlideCompletion(c, 1, outcomes);
    expect(completion.complete).toBe(false);
    expect(completion.reasons.join(' ')).toContain('unavailable');
  });
});

describe('hook-only edit: deterministic approved-mask compositing', () => {
  const openerRequest = (over: Record<string, unknown> = {}) => baseRequest({
    overlayOverrides: { '0': 'NEW OPENER' },
    openerEdit: {
      outputIndex: 0,
      geometry: { x: 100, y: 80, width: 400, height: 200 },
      mask: { sha256: 'b'.repeat(64), width: 1080, height: 1920, cleanBaseRef: 'workspace/vid1/clean/opener.png', clean: true },
    },
    ...over,
  });

  const rgba = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Rgba => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r!; data[i + 1] = g!; data[i + 2] = b!; data[i + 3] = a!;
    }
    return { width: w, height: h, data };
  };
  const maskOn = rgba(8, 8, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const geometry = { x: 2, y: 2, width: 4, height: 4 };

  test('only the approved opener composites; every other slide reuses its original', () => {
    const c = compileExactEdit(openerRequest());
    const opener = prepareExactEditSlide({ exactEdit: c }, 0);
    expect(opener.action).toBe('composite_opener');
    expect(opener.geometry).toEqual({ x: 100, y: 80, width: 400, height: 200 });
    expect(opener.maskSha256).toBe('b'.repeat(64));
    expect(opener.serviceCalls).toBe(0);
    for (const i of [1, 2, 3, 4]) expect(prepareExactEditSlide({ exactEdit: c }, i).action).toBe('reuse_original');
  });

  test('compositing changes only in-mask pixels and the outside comparison is exact', () => {
    const source = rgba(8, 8, (x, y) => [x * 30, y * 30, 10, 255]);
    const layer = rgba(8, 8, () => [255, 0, 0, 255]);
    const out = composeApprovedMask(source, maskOn, layer, geometry);
    expect(compareOutsideMask(source, out, maskOn, geometry)).toEqual({ outsidePixels: 48, outsideDiffPixels: 0, result: 'exact' });
    // Deterministic: the same inputs produce identical bytes.
    expect(composeApprovedMask(source, maskOn, layer, geometry).data).toEqual(out.data);
    expect(out.data).not.toEqual(source.data);
  });

  test('one changed body pixel outside the mask is a preservation failure', () => {
    const source = rgba(8, 8, (x, y) => [x * 30, y * 30, 10, 255]);
    const out = composeApprovedMask(source, maskOn, rgba(8, 8, () => [255, 0, 0, 255]), geometry);
    const body = structuredClone(out);
    body.data[(7 * 8 + 7) * 4] = 9; // far outside the mask
    expect(compareOutsideMask(source, body, maskOn, geometry).result).toBe('mismatch');
  });

  test('a pixel just outside the approved mask is still a failure', () => {
    const source = rgba(8, 8, (x, y) => [x * 30, y * 30, 10, 255]);
    const out = composeApprovedMask(source, maskOn, rgba(8, 8, () => [255, 0, 0, 255]), geometry);
    const widened = structuredClone(out);
    widened.data[(1 * 8 + 1) * 4] = 1; // inside the geometry, outside the mask
    expect(compareOutsideMask(source, widened, maskOn, geometry).result).toBe('mismatch');
  });

  test('wrong dimensions are refused rather than resized', () => {
    const source = rgba(8, 8, (x, y) => [x * 30, y * 30, 10, 255]);
    const wrong = rgba(4, 4, () => [0, 0, 0, 255]);
    expect(codeOf(() => composeApprovedMask(source, maskOn, wrong, geometry))).toBe('dimension_mismatch');
    expect(codeOf(() => compareOutsideMask(source, wrong, maskOn, geometry))).toBe('dimension_mismatch');
  });

  test('a mask expanded after consent invalidates the contract', () => {
    const c = compileExactEdit(openerRequest());
    const mutated = structuredClone(c);
    mutated.openerEdit!.mask.sha256 = 'c'.repeat(64);
    expect(codeOf(() => assertExactEditContractIntact(mutated))).toBe('exact_edit_contract_mutated');
  });

  test('without an approved clean base/layer the scope is refused, never regenerated', () => {
    expect(codeOf(() => compileExactEdit(openerRequest({
      openerEdit: {
        outputIndex: 0, geometry: { x: 0, y: 0, width: 10, height: 10 },
        mask: { sha256: 'b'.repeat(64), width: 1080, height: 1920, cleanBaseRef: 'workspace/vid1/clean/opener.png', clean: false },
      },
    })))).toBe('unsupported_compositing');
  });

  test('an opener composite requires an explicit slide-0 override', () => {
    expect(codeOf(() => compileExactEdit(baseRequest({
      openerEdit: {
        outputIndex: 0, geometry: { x: 0, y: 0, width: 10, height: 10 },
        mask: { sha256: 'b'.repeat(64), width: 1080, height: 1920, cleanBaseRef: 'workspace/vid1/clean/opener.png', clean: true },
      },
    })))).toBe('missing_opener_override');
  });

  test('there is no full-frame fallback: an unmapped slide has no plan', () => {
    const c = compileExactEdit(openerRequest());
    expect(codeOf(() => prepareExactEditSlide({ exactEdit: c }, 9))).toBe('invalid_slide_mapping');
  });
});

describe('asset reuse proof', () => {
  const pixels = (v: number) => ({ width: 4, height: 4, data: new Uint8Array(64).fill(v) });

  test('identical pinned SHA-256 proves byte reuse', () => {
    expect(verifyAssetReuse({ pinnedSha256: 'a'.repeat(64), outputSha256: 'a'.repeat(64) }).result).toBe('byte_identical');
  });

  test('a hash difference alone is inconclusive and never a pass', () => {
    const verdict = verifyAssetReuse({ pinnedSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) });
    expect(verdict.result).toBe('inconclusive');
    expect(verdict.detail).toContain('proves nothing');
  });

  test('canonical decoded pixels settle a re-encoded transport', () => {
    expect(verifyAssetReuse({ pinnedSha256: null, outputSha256: 'b'.repeat(64), originalPixels: pixels(7), outputPixels: pixels(7) }).result).toBe('pixel_identical');
    const changed = pixels(7);
    changed.data[10] = 8;
    expect(verifyAssetReuse({ pinnedSha256: null, outputSha256: 'b'.repeat(64), originalPixels: pixels(7), outputPixels: changed }).result).toBe('mismatch');
  });

  test('a wrong crop or dimension under re-encoding is a mismatch', () => {
    const verdict = verifyAssetReuse({
      pinnedSha256: null, outputSha256: 'b'.repeat(64),
      originalPixels: { width: 4, height: 4, data: new Uint8Array(64).fill(7) },
      outputPixels: { width: 9, height: 16, data: new Uint8Array(9 * 16 * 4).fill(7) },
    });
    expect(verdict.result).toBe('mismatch');
    expect(verdict.detail).toContain('dimensions');
  });
});

describe('completion gate', () => {
  test('a fully passing check set completes the slide', () => {
    const c = compileExactEdit(baseRequest());
    const outcomes = requiredChecks(c, 2).map(check => ({ outputIndex: 2, check, status: 'pass' as const }));
    expect(exactEditSlideCompletion(c, 2, outcomes)).toEqual({ complete: true, reasons: [] });
  });

  test('a failed, errored or unavailable check cannot complete the slide', () => {
    const c = compileExactEdit(baseRequest());
    for (const status of ['fail', 'error', 'unavailable'] as const) {
      const outcomes = requiredChecks(c, 2).map((check, i) => ({ outputIndex: 2, check, status: i === 0 ? status : 'pass' as const }));
      const result = exactEditSlideCompletion(c, 2, outcomes);
      expect(result.complete).toBe(false);
      expect(result.reasons.join(' ')).toContain(status);
    }
  });

  test('an unrecorded required check cannot complete: no sampling, no missing pass', () => {
    const c = compileExactEdit(baseRequest());
    const partial = requiredChecks(c, 2).slice(1).map(check => ({ outputIndex: 2, check, status: 'pass' as const }));
    const result = exactEditSlideCompletion(c, 2, partial);
    expect(result.complete).toBe(false);
    expect(result.reasons.join(' ')).toContain('No result recorded');
  });

  test('a check outside the contract is a finding, not silently ignored', () => {
    const c = compileExactEdit(baseRequest());
    const outcomes = [
      ...requiredChecks(c, 2).map(check => ({ outputIndex: 2, check, status: 'pass' as const })),
      { outputIndex: 2, check: 'the model looked right', status: 'pass' as const },
    ];
    const result = exactEditSlideCompletion(c, 2, outcomes);
    expect(result.complete).toBe(false);
    expect(result.reasons.join(' ')).toContain('not part of contract');
  });

  test('the gate binds to the contract hash, so a mutated contract cannot be verified against', () => {
    const c = compileExactEdit(baseRequest());
    const outcomes = requiredChecks(c, 2).map(check => ({ outputIndex: 2, check, status: 'pass' as const }));
    const mutated = structuredClone(c) as ExactEditContract;
    mutated.slides[2]!.effectiveOverlayText = 'different';
    expect(codeOf(() => exactEditSlideCompletion(mutated, 2, outcomes))).toBe('exact_edit_contract_mutated');
  });

  test('the reuse check is required on every unchanged included slide', () => {
    const c = compileExactEdit(baseRequest());
    for (const s of c.slides) {
      expect(requiredChecks(c, s.outputIndex)).toContain('the output bytes are identical to the pinned original asset');
    }
  });
});