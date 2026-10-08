// SLA-430 D1/D2/D7 at the provider boundary: recorded source copy is classified
// once, carried into the board prompt, and the SAME resolved per-slide contract
// reaches the render request and the QA checker.
import { expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { observedCopy, prepare, resolvedCopyBlock } from './providers.js';
import { VideoAnalysisDataSchema } from '../analysis/schema.js';
import type { Experiment, Input, Task } from './schema.js';
import { compileSlideContract, contractCheckPlan, contractChecks, labelPolicy, type SlideContract } from './render-prompt.js';
import { editInstructions } from '../tools/experiments.js';

const analysis = (shots: Array<{ timestampSec: number; description: string }>, onScreenText: Array<{ timestampSec: number; text: string }> = []) => VideoAnalysisDataSchema.parse({
  shots: shots.map(s => ({ ...s, durationSec: 0, type: 'other', onScreenText: null })),
  onScreenText: onScreenText.map(o => ({ ...o, style: 'overlay' })),
  keyMoments: null, audioAnalysis: null, emotionalArc: null,
  hook: { text: '', type: 'other', placement: 'other', mechanism: '' },
  angle: { type: 'other', description: '' },
  storytellingBeats: [{ type: 'other', timestampSec: 0, description: '' }],
  keyMechanisms: ['other'], emotionalDrivers: ['other'],
  pacing: { rhythm: '', retentionStrategy: '', cutsPerMinute: null },
  visualTechniques: [], audioTechniques: [],
  audienceInsight: { targetDemographic: '', unspokenDesire: '' },
  transferablePatterns: [{ pattern: '', description: '', adaptationNotes: '' }],
  overallAssessment: { summary: '', viralityScore: 5, replicability: 'medium' },
});

test('observedCopy separates real copy, verified blanks and unknown extraction', () => {
  // Two text-free slides plus one slide the analyzer reported words for.
  const rows = observedCopy(analysis([
    { timestampSec: 0, description: 'Six men, plain white background' },
    { timestampSec: 1, description: 'Close-up, plain white background' },
    { timestampSec: 2, description: 'Profile card' },
  ], [{ timestampSec: 2, text: 'average european' }]), true, 3)!;
  expect(rows).toEqual([
    { slideIndex: 0, state: 'observed_empty', text: '' },
    { slideIndex: 1, state: 'observed_empty', text: '' },
    { slideIndex: 2, state: 'observed_text', text: 'average european' },
  ]);
  // A slide the analysis never covered is an evidence gap, not a verified blank.
  expect(observedCopy(analysis([{ timestampSec: 0, description: 'One slide' }]), true, 3)![1]).toEqual({ slideIndex: 1, state: 'unknown', text: null });
  // An unusable analysis record makes every slide unknown rather than inventing text.
  expect(observedCopy({ nonsense: true }, true, 2)).toEqual([
    { slideIndex: 0, state: 'unknown', text: null },
    { slideIndex: 1, state: 'unknown', text: null },
  ]);
  // Video-only experiments have no per-slide copy contract.
  expect(observedCopy(analysis([{ timestampSec: 0, description: 'x' }]), false, 3)).toEqual([]);
});

test('the board prompt is told the resolved copy so a blank slide cannot acquire words', () => {
  const copy = observedCopy(analysis([
    { timestampSec: 0, description: 'Six men' }, { timestampSec: 1, description: 'Close-up' },
    { timestampSec: 2, description: 'Profile card' }, { timestampSec: 3, description: 'Portrait' },
    { timestampSec: 4, description: 'Studio' }, { timestampSec: 5, description: 'Final' },
  ], [{ timestampSec: 5, text: 'average european' }]), true, 6)!;
  const e = { inputs: [{ videoId: '81c0c508', status: 'ready', copy }] } as unknown as Pick<Experiment, 'inputs'>;
  const block = resolvedCopyBlock(e);
  expect(block).toContain('slide 0: overlay is "" (observed blank — render NO added text)');
  expect(block).toContain('slide 5: overlay is "average european"');
  expect(block).not.toContain('Official ratings');
});

function sourceReferenced(opts: { copy: Input['copy']; variables: string[]; changed?: Array<{ name: string; value: string }>; scene?: string; character?: string }) {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const videos = ['src'].map(id => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: [0, 1, 2].map(i => `w/${id}/slides/0${i}.jpg`) }) } as Video));
  const slides = [0, 1, 2].map(i => ({ role: 'proof', scene: opts.scene ?? 'A man with curly light-brown hair and blue eyes wearing a blue hockey jersey, looking right.', overlayText: 'Official ratings' }));
  const brief = { concept: 'Guide', hook: 'Official ratings', character: opts.character ?? 'Adult', visualStyle: 'Editorial', caption: '', cta: '', lockedConstraints: [], slides };
  const e = {
    id: 'e', workspaceId: 'w', status: 'generating', generationBasis: 'source-referenced', styleFormula: { medium: 'photograph', density: 'minimal' },
    inputs: [{ videoId: 'src', status: 'ready', analysisId: 'an1', jobId: null, error: null, coverage: null, evidence: [], copy: opts.copy }] as Input[],
    instructions: { language: 'English', brand: '', audience: '', goal: 'g', direction: 'nordic', lockedConstraints: [], variables: opts.variables, mode: 'exploration' },
    variants: [{ id: 'v', revision: 1, baselineId: null, changedVariables: opts.changed ?? [], frozenBrief: brief, slides: [] }],
  } as unknown as Experiment;
  return { e, videos };
}

const deps = (videos: Video[], calls: unknown[], qa: SlideContract[] = []) => ({
  findSources: async () => videos,
  generateImage: async (o: unknown) => { calls.push(o); return { buffer: Buffer.alloc(600), contentType: 'image/jpeg', costUsd: 0 }; },
  upload: async () => ({ path: 'stored', sizeBytes: 600 }),
  describeCandidates: async (b: Buffer[]) => b.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}`, overdesigned: false })),
  classify: async () => ({ value: 'c0', confidence: 0.9 }),
  jevScores: async () => ({}),
  generateBriefCandidates: async () => { throw new Error('not used'); },
  verifyStory: async (o: { contract: SlideContract }) => { qa.push(o.contract); return { verdict: 'pass' as const, reasons: [], checks: [{ check: 'c', status: 'pass' as const }], contractHash: o.contract.contractHash, corrected: false, attempts: 1 }; },
});
const task = { id: 't', kind: 'slide', target: 'v', index: 0 } as Task;

test('character edit instructions reach rendering and QA while preserving source text', async () => {
  const casting = 'short blonde hair, light eyes';
  const { e, videos } = sourceReferenced({
    copy: [0, 1, 2].map(slideIndex => ({ slideIndex, state: 'observed_text' as const, text: 'Original headline' })),
    variables: ['character'], changed: [{ name: 'character', value: casting }],
  });
  e.instructions = editInstructions(undefined, [], 'English', { variables: ['character'], character: casting });
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  await (await prepare(e, task, deps(videos, calls, qa) as never)).execute();
  expect(qa[0]!.overlay).toEqual({ mode: 'preserve', text: 'Original headline', origin: 'source' });
  expect(qa[0]!.subject.castingTarget).toMatchObject({ hair: 'short blonde hair', eyes: 'light eyes' });
  const prompt = (calls[0] as { prompt: string }).prompt;
  expect(prompt).toContain('CASTING TARGET');
  expect(prompt).toContain('Original headline');
  expect(prompt).not.toContain('Official ratings');
  expect(prompt).toContain(qa[0]!.contractHash);
});

test('combined hook and character changes reach rendering and QA together', async () => {
  const { e, videos } = sourceReferenced({
    copy: [0, 1, 2].map(slideIndex => ({ slideIndex, state: 'observed_text' as const, text: 'Original headline' })),
    variables: ['hook', 'character'], changed: [{ name: 'hook', value: 'Official ratings' }, { name: 'character', value: 'short blonde hair, light eyes' }],
  });
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  await (await prepare(e, task, deps(videos, calls, qa) as never)).execute();
  expect(qa[0]!.overlay.text).toBe('Official ratings');
  expect(qa[0]!.overlay.origin).toBe('brief');
  expect(qa[0]!.subject.castingTarget).toMatchObject({ hair: 'short blonde hair', eyes: 'light eyes' });
  const prompt = (calls[0] as { prompt: string }).prompt;
  expect(prompt).toContain('Official ratings');
  expect(prompt).toContain('CASTING TARGET');
  expect(prompt).toContain(qa[0]!.contractHash);
});

test('a blank source slide renders no added overlay and QA checks the same empty value', async () => {
  const blank = [{ slideIndex: 0, state: 'observed_empty' as const, text: '' }, { slideIndex: 1, state: 'observed_empty' as const, text: '' }, { slideIndex: 2, state: 'observed_empty' as const, text: '' }];
  const { e, videos } = sourceReferenced({ copy: blank, variables: ['character'] });
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  const result = await (await prepare(e, task, deps(videos, calls, qa) as never)).execute() as { prompt: string; story: { contractHash: string } };
  // The brief invented "Official ratings"; the resolved source copy is blank and wins.
  expect(result.prompt).not.toContain('Official ratings');
  expect(result.prompt).toContain('the only ADDED text rendered in the image is ""');
  expect(qa[0]!.overlay).toEqual({ mode: 'clear', text: '', origin: 'source' });
  expect(contractChecksFrom(result.prompt)).toContain('the slide carries no added overlay text');
  // The identical record, and its hash, reached both operations.
  expect(result.story.contractHash).toBe(qa[0]!.contractHash);
  expect(result.prompt).toContain(qa[0]!.contractHash);
});

test('an unlocked casting target reaches the render prompt and the QA contract identically', async () => {
  const { e, videos } = sourceReferenced({
    copy: [{ slideIndex: 0, state: 'observed_empty', text: '' }, { slideIndex: 1, state: 'observed_empty', text: '' }, { slideIndex: 2, state: 'observed_empty', text: '' }],
    variables: ['character'],
    changed: [{ name: 'character', value: 'males with long straight or pulled-back blonde/light hair, light eyes' }],
  });
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  await (await prepare(e, task, deps(videos, calls, qa) as never)).execute();
  const contract = qa[0]!;
  expect(contract.subject.castingTarget).toEqual({ hair: 'long straight or pulled-back blonde/light hair', eyes: 'light eyes' });
  // The source's dark/blonde wording is superseded, and gaze stays locked.
  expect(contract.subject.supersededPhrases).toContain('curly light-brown hair');
  expect(contract.compiledScene).toContain('long straight or pulled-back blonde/light hair');
  expect(contract.compiledScene).not.toContain('curly light-brown hair');
  expect(contract.subject.lockedAttributes.find(l => l.attribute === 'gaze')?.observed).toBe('looking right');
  expect(contract.subject.castingTarget).not.toHaveProperty('gaze');
  const prompt = (calls[0] as { prompt: string }).prompt;
  expect(prompt).toContain('CASTING TARGET');
  expect(prompt).toContain(contract.contractHash);
});

test('an unknown source copy state stops preparation before any provider call', async () => {
  const { e, videos } = sourceReferenced({
    copy: [{ slideIndex: 0, state: 'unknown', text: null }, { slideIndex: 1, state: 'observed_empty', text: '' }, { slideIndex: 2, state: 'observed_empty', text: '' }],
    variables: ['character'],
  });
  const calls: unknown[] = [];
  const err = await prepare(e, task, deps(videos, calls) as never).catch(e => e as Error & { code?: string });
  expect((err as { code?: string }).code).toBe('unknown_source_copy');
  expect(calls).toHaveLength(0);
});

test('an explicit per-slide copy override wins over the source value', async () => {
  const { e, videos } = sourceReferenced({
    copy: [{ slideIndex: 0, state: 'observed_empty', text: '' }, { slideIndex: 1, state: 'observed_empty', text: '' }, { slideIndex: 2, state: 'observed_empty', text: '' }],
    variables: ['character'], character: 'Adult',
  });
  (e.variants[0]!.frozenBrief as { copyOverrides?: Record<string, string> }).copyOverrides = { '0': '' };
  const qa: SlideContract[] = []; const calls: unknown[] = [];
  await (await prepare(e, task, deps(videos, calls, qa) as never)).execute();
  expect(qa[0]!.overlay).toEqual({ mode: 'clear', text: '', origin: 'override' });
});

/** Read the contract checks back out of the render prompt JSON payload. */
function contractChecksFrom(prompt: string): string[] {
  const line = prompt.split('\n').find(l => l.startsWith('{"language"'))!;
  return JSON.parse(line).contract.checks as string[];
}

// SLA-545: only lock what was observed; person-appearance locks only for a person.
const contractFor = (medium: string, scene: string) => compileSlideContract({
  slideIndex: 0, role: 'hook', medium, scene, overlay: { mode: 'clear', text: '', origin: 'source' }, observedCopy: null,
  sourceMap: { videoId: null, analysisId: null, sourceIndex: null, referenceKind: 'none', path: null }, labels: labelPolicy(),
});
const attributesOf = (c: SlideContract) => c.subject.lockedAttributes.map(l => l.attribute);

test('a statue-collage contract emits no hair, jewelry or wardrobe checks', () => {
  const c = contractFor('collage', '2x2 photo-food collage; right: a grayscale marble statue of a man looking left, plain grey backdrop.');
  expect(attributesOf(c).sort()).toEqual(['gaze', 'role', 'setting']);
  const checks = contractChecks(c).join('\n');
  for (const noun of ['hair', 'eyes', 'complexion', 'wardrobe', 'jewelry', 'facial-hair']) expect(checks).not.toContain(`subject's ${noun}`);
  expect(checks).not.toContain('unchanged from the reference frame');
});

test('a pixel-art / objects contract emits no subject-appearance checks', () => {
  const c = contractFor('animated', 'Left: a photographed burger and fries. Right: the same foods as Minecraft pixel-art sprites, no character anywhere.');
  expect(c.subject.lockedAttributes.filter(l => !['role', 'gaze', 'setting'].includes(l.attribute))).toEqual([]);
  expect(contractChecks(c).some(x => x.includes("the subject's"))).toBe(false);
  const objects = contractFor('unknown-objects', 'A pile of golden pixel coins on a dark background.');
  expect(contractChecks(objects).some(x => /hair|eyes|jewelry|wardrobe/.test(x))).toBe(false);
});

test('a photographed person keeps observed locks, and unobserved ones only as soft source-frame comparisons', () => {
  const c = contractFor('photograph', 'A man with dark hair and a black t-shirt, looking left.');
  expect(c.subject.lockedAttributes.filter(l => l.observed).map(l => l.attribute)).toEqual(expect.arrayContaining(['hair', 'wardrobe', 'gaze']));
  const plan = contractCheckPlan(c, { sourceBaseline: true });
  const unobserved = plan.filter(x => x.check.includes('unchanged from the reference frame'));
  expect(unobserved.every(x => x.scope === 'comparison' && x.severity === 'soft')).toBe(true);
});

test.each(['unknown', 'mixed', 'collage', 'animated'])('a %s medium emits no person-appearance lock, observed or not', medium => {
  const c = contractFor(medium, 'A man with red hair, a black t-shirt and gold earrings, looking left in a grey room.');
  const attrs = attributesOf(c);
  for (const person of ['hair', 'eyes', 'facial-hair', 'complexion', 'wardrobe', 'jewelry']) expect(attrs).not.toContain(person);
  expect(attrs).toEqual(expect.arrayContaining(['role', 'gaze']));
  expect(c.subject.lockedAttributes.every(l => l.observed)).toBe(true);
  expect(contractChecks(c, { sourceBaseline: true }).join('\n')).not.toMatch(/hair|wardrobe|jewelry|eyes|complexion/);
});

test('overlay and medium are hard checks; subject, setting and story beat are soft', () => {
  const specs = contractCheckPlan(contractFor('photograph', 'A man with dark hair, looking left, grey backdrop.'));
  const sev = (needle: string) => specs.find(x => x.check.includes(needle))!.severity;
  expect(sev('overlay')).toBe('hard');
  expect(sev('medium')).toBe('hard');
  expect(sev('hair is unchanged')).toBe('soft');
  expect(sev('story beat')).toBe('soft');
});

test('a hook-text slide is rendered and checked against its own source description, not the board scene', async () => {
  const { e, videos } = sourceReferenced({
    copy: [0, 1, 2].map(slideIndex => ({ slideIndex, state: 'observed_text' as const, text: 'Original headline' })),
    variables: ['hook'], changed: [], scene: 'Foods spiraling around him in a new layout.',
  });
  e.inputs[0]!.evidence = [0, 1, 2].map(i => ({ location: `slide:${i}`, observation: `2x2 grid of foods, slide ${i}` }));
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  await (await prepare(e, task, deps(videos, calls, qa) as never)).execute();
  expect(qa[0]!.compiledScene).toBe('2x2 grid of foods, slide 0');
  expect((calls[0] as { prompt: string }).prompt).not.toContain('spiraling');
});
