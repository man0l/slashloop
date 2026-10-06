// SLA-533: a controlled visualStyle variant keeps the storyline but NOT the
// baseline layout. Its visualStyle is the authority for medium, art direction
// and composition — including when the variant copies the baseline's scene
// strings verbatim and visualStyle is the only place the new layout is stated.
import { describe, expect, test } from 'bun:test';
import { buildVariantSlidePrompt, compileSlideContract, contractChecks, contractQaBlock, labelPolicy, renderContract, styleContract, styleOwnsComposition, variantStyleDirective } from './render-prompt.js';
import { prepare } from './providers.js';
import type { BriefData, Experiment, SlideVerification, Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';

const BASELINE_SCENE = 'A column of fast food stacked on the left side of the frame; a marble statue stands on the right.';
const VARIANT_STYLE = 'Centered marble statue, food spilling over both shoulders, symmetrical frame, soft museum light';

const baseline: BriefData = {
  concept: 'Gods eat junk too', hook: 'Even statues cheat', character: '', visualStyle: 'Flat studio photo, food left, statue right',
  caption: 'cap', cta: '', lockedConstraints: [],
  slides: [
    { role: 'hook', scene: BASELINE_SCENE, overlayText: 'Even statues cheat' },
    { role: 'payoff', scene: 'The statue holds a burger to its lips.', overlayText: 'Day 30' },
  ],
};
// Controlled visualStyle A/B: same per-slide storyline, only visualStyle differs.
const variant: BriefData = { ...structuredClone(baseline), visualStyle: VARIANT_STYLE };
const ctx = { language: 'English', brand: 'B', audience: 'A', unlocked: ['visualStyle'] as const, styleFormula: { medium: 'photograph', density: 'minimal' } };
const styleOnly = () => renderContract(['visualStyle'], [{ name: 'visualStyle' }]);

describe('visualStyle variant owns composition (render prompt)', () => {
  test('the contract is story-locked and style-unlocked', () => {
    const c = styleOnly();
    expect(c).toMatchObject({ kind: 'visualStyle', changeStyle: true, changeStory: false, changeSetting: false, changeFaces: false });
    expect(styleOwnsComposition(c)).toBe(true);
    // A baseline/slides contract retells the story, so it never takes this path.
    expect(styleOwnsComposition(renderContract(['visualStyle'], []))).toBe(false);
    expect(styleOwnsComposition(renderContract(['slides', 'visualStyle'], [{ name: 'slides' }, { name: 'visualStyle' }]))).toBe(false);
  });

  test('the exact visualStyle directive is a composition requirement and the baseline layout is not preserved', () => {
    const prompt = buildVariantSlidePrompt(variant, 0, ctx, styleOnly());
    expect(prompt).toContain(variantStyleDirective(VARIANT_STYLE));
    expect(prompt).toContain(`LOOK + COMPOSITION (the A/B): apply visualStyle "${VARIANT_STYLE}"`);
    expect(prompt).toMatch(/composition\/layout/);
    expect(prompt).toContain('Keeping this slide\'s storyline does NOT mean keeping the baseline composition.');
    // None of the frame-layout locks a copy-only A/B carries.
    expect(prompt).not.toContain('SETTING / COMPOSITION: match the attached frame EXACTLY');
    expect(prompt).not.toContain('same layout');
    expect(prompt).not.toContain('Output the SAME photograph');
    expect(prompt).not.toContain(`keep visualStyle "${VARIANT_STYLE}"`);
  });

  test('the slide scene is kept as the story beat, with no permission to retell the story', () => {
    const prompt = buildVariantSlidePrompt(variant, 0, ctx, styleOnly());
    expect(prompt).toContain(BASELINE_SCENE);
    expect(prompt).toContain('STORY: this slide\'s scene beat');
    expect(prompt).toContain('Do not retell, add or drop story beats.');
    expect(prompt).not.toContain('A new story is allowed');
    const json = JSON.parse(prompt.split('\n').find(l => l.startsWith('{'))!);
    expect(json.slide).toMatchObject({ scene: BASELINE_SCENE, sceneAuthority: 'story beat only', compositionFrom: 'visualStyle' });
  });

  test('precedence is deterministic: the variant directive comes first and the style formula yields to it', () => {
    for (const medium of ['photograph', 'collage', 'caricature', 'mixed']) {
      const prompt = buildVariantSlidePrompt(variant, 1, { ...ctx, styleFormula: { medium, density: 'minimal' } }, styleOnly());
      const lines = prompt.split('\n');
      expect(lines[0]).toBe(variantStyleDirective(VARIANT_STYLE));
      expect(lines[1]).toBe(styleContract({ medium, density: 'minimal' }, { yieldToVariantStyle: true }));
      expect(lines[1]).toContain('the VARIANT VISUAL STYLE wins');
      expect(lines[1]).not.toContain('(highest priority)');
      // Exactly one "highest priority" claim, and it is the variant's.
      expect(prompt.match(/highest priority/g)).toHaveLength(1);
    }
    // Same inputs, same prompt.
    expect(buildVariantSlidePrompt(variant, 0, ctx, styleOnly())).toBe(buildVariantSlidePrompt(variant, 0, ctx, styleOnly()));
  });

  test('objects stay the same things but their arrangement follows visualStyle', () => {
    const prompt = buildVariantSlidePrompt(variant, 0, { ...ctx, styleFormula: { medium: 'mixed', density: 'minimal' } }, styleOnly());
    expect(prompt).toContain('Their arrangement follows the VARIANT VISUAL STYLE, not the attached frame.');
    expect(prompt).not.toContain('keep the attached frame\'s objects, materials and composition');
  });
});

describe('existing locks are unchanged', () => {
  test('hook-only stays a text edit of the locked frame', () => {
    const prompt = buildVariantSlidePrompt({ ...baseline, hook: 'New hook' }, 0, { ...ctx, unlocked: ['hook'] }, 'hook-text');
    expect(prompt).toContain('Output the SAME photograph with new overlay text only.');
    expect(prompt).toContain('SETTING / COMPOSITION: match the attached frame EXACTLY');
    expect(prompt).toContain(`LOOK: keep visualStyle "${baseline.visualStyle}"`);
    expect(prompt).not.toContain('VARIANT VISUAL STYLE');
    expect(prompt.split('\n')[0]).toBe(styleContract(ctx.styleFormula));
  });

  test('character-only keeps the frame layout and style', () => {
    const prompt = buildVariantSlidePrompt({ ...baseline, character: 'An older bronze statue' }, 0, { ...ctx, unlocked: ['character'] }, 'character');
    expect(prompt).toContain('SETTING / COMPOSITION: match the attached frame EXACTLY');
    expect(prompt).toContain(`LOOK: keep visualStyle "${baseline.visualStyle}"`);
    expect(prompt).not.toContain('VARIANT VISUAL STYLE');
  });

  test('a baseline (open) render follows its scene and is not re-composed by visualStyle', () => {
    const prompt = buildVariantSlidePrompt(baseline, 0, { ...ctx, unlocked: ['visualStyle'] }, renderContract(['visualStyle'], []));
    expect(prompt).not.toContain('VARIANT VISUAL STYLE');
    expect(prompt).toContain('STORY / SETTING: follow the slide scene.');
  });
});

describe('QA judges composition against the variant visualStyle', () => {
  const compile = (variantVisualStyle?: string | null) => compileSlideContract({
    slideIndex: 0, role: 'hook', medium: 'photograph', scene: BASELINE_SCENE,
    overlay: { mode: 'preserve', text: 'Even statues cheat', origin: 'source' }, observedCopy: { state: 'observed_text', text: 'Even statues cheat' },
    sourceMap: { videoId: 'v', analysisId: null, sourceIndex: 0, referenceKind: 'baseline', path: null },
    labels: labelPolicy(), variantVisualStyle,
  });

  test('a visualStyle contract checks layout against visualStyle, not the baseline', () => {
    const c = compile(VARIANT_STYLE);
    const checks = contractChecks(c);
    expect(checks).toContain(`the medium, art direction and composition/layout follow the variant visualStyle: ${JSON.stringify(VARIANT_STYLE)} (the reference frame's and the scene's baseline arrangement are NOT a requirement)`);
    expect(checks.some(k => k.includes('story beat for role "hook" is visible'))).toBe(true);
    expect(checks.some(k => k.startsWith('the medium is photograph'))).toBe(false);
    expect(contractQaBlock(c)).toMatchObject({ variantVisualStyle: VARIANT_STYLE, compositionAuthority: 'variantVisualStyle', sceneAuthority: 'story beat only' });
  });

  test('contracts without a variant visualStyle keep their checks and hash', () => {
    const plain = compile(undefined);
    expect(compile(null).contractHash).toBe(plain.contractHash);
    expect(plain.variantVisualStyle).toBeUndefined();
    expect(contractChecks(plain)).toContain('the medium is photograph and the story beat for role "hook" is visible');
    expect(contractQaBlock(plain)).not.toHaveProperty('variantVisualStyle');
    expect(compile(VARIANT_STYLE).contractHash).not.toBe(plain.contractHash);
  });
});

describe('provider wiring (prepare → render + QA)', () => {
  const instructions = { goal: 'g', brand: 'B', audience: 'A', language: 'English', direction: '', lockedConstraints: [], variables: ['visualStyle' as const], mode: 'controlled' as const };
  function experiment(changed: Array<{ name: string; value: string }>, brief: BriefData): Experiment {
    const base = { id: 'b0', revision: 1, status: 'done', title: 'A', hypothesis: 'h', changedVariables: [], brief: baseline, frozenBrief: baseline,
      slides: [{ status: 'done', url: 'https://img.test/b0-0.jpg', path: 'b0/0.jpg' }, { status: 'done', url: 'https://img.test/b0-1.jpg', path: 'b0/1.jpg' }] };
    const v = { id: 'v1', revision: 1, status: 'draft', title: 'B', hypothesis: 'h', baselineId: 'b0', changedVariables: changed, brief, frozenBrief: brief, slides: [] };
    return { id: 'e', workspaceId: 'w', status: 'generating', version: 1, createdAt: '', updatedAt: '', instructions, variantCount: 2, slideCount: 2, maxCredits: 100, creditsCharged: 5,
      report: { summary: 'S' }, inputs: [], variants: [base, v], error: null, generationBasis: 'source-referenced', assetPolicy: 'retained',
      tasks: [{ id: 't0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 10 }], commands: {}, allowPartial: false, createFingerprint: 'x' } as unknown as Experiment;
  }
  async function render(e: Experiment) {
    process.env.OPENROUTER_API_KEY = 'test';
    process.env.R2_THUMB_PUBLIC_BASE = 'https://thumbs.test';
    const prompts: string[] = [];
    const contracts: SlideContract[] = [];
    const deps = {
      findSources: async () => [] as never[],
      generateImage: async (opts: { prompt: string }) => { prompts.push(opts.prompt); return { buffer: Buffer.alloc(600, 1), contentType: 'image/jpeg', costUsd: 0 }; },
      upload: async () => ({ path: 'p', sizeBytes: 1 }),
      describeCandidates: async () => [{ id: 'c0', description: 'statue', medium: 'photograph', textBlocks: 1, overdesigned: false }],
      classify: async () => ({ choice: 'c0', confidence: 0.5 }),
      verifyStory: async (opts: { contract: SlideContract }): Promise<SlideVerification> => {
        contracts.push(opts.contract);
        return { verdict: 'pass', reasons: [], checks: contractChecks(opts.contract).map(check => ({ check, status: 'pass' as const })), contractHash: opts.contract.contractHash, corrected: false, attempts: 1 };
      },
      generateBriefCandidates: async () => { throw new Error('not used'); },
      jevScores: async () => { throw new Error('not used'); },
    } as unknown as Parameters<typeof prepare>[2];
    const prepared = await prepare(e, { id: 't0', kind: 'slide', target: 'v1', index: 0, attempts: 0, charged: 10 } as unknown as Task, deps);
    await prepared.execute();
    return { units: prepared.units, prompt: prompts[0]!, contract: contracts[0]! };
  }

  test('a visualStyle variant on the baseline frame is re-composed, not text-edited', async () => {
    const { units, prompt, contract } = await render(experiment([{ name: 'visualStyle', value: VARIANT_STYLE }], variant));
    expect(units).toBe(1); // same unit count as before: one render on the identity frame
    expect(prompt.split('\n')[0]).toBe(variantStyleDirective(VARIANT_STYLE));
    expect(prompt).toContain('"visualLock":"visualStyle"');
    expect(prompt).not.toContain('change overlay text only');
    expect(prompt).not.toContain('SETTING / COMPOSITION: match the attached frame EXACTLY');
    expect(prompt).not.toContain('Keep its SUBJECT and LAYOUT');
    expect(prompt).toContain('Do NOT keep its layout, framing, arrangement or look');
    expect(prompt).toContain(BASELINE_SCENE);
    expect(contract.variantVisualStyle).toBe(VARIANT_STYLE);
  });

  test('a hook variant in the same experiment shape stays a locked text edit', async () => {
    const hooked = { ...structuredClone(baseline), hook: 'Statues cheat too' };
    const e = experiment([{ name: 'hook', value: 'Statues cheat too' }], hooked);
    e.instructions.variables = ['hook', 'visualStyle'] as never;
    const { prompt, contract } = await render(e);
    expect(prompt).toContain('change overlay text only');
    expect(prompt).toContain('SETTING / COMPOSITION: match the attached frame EXACTLY');
    expect(prompt).toContain('Keep its SUBJECT and LAYOUT');
    expect(prompt).not.toContain('VARIANT VISUAL STYLE');
    expect(contract.variantVisualStyle).toBeUndefined();
  });
});
