// SLA-550: the scene, copy and source map a slide is judged against belong to the frame the renderer
// was actually handed — its videoId and its exact `slide:N` — never to a rotated or compacted list.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { prepare, sourceSlideDescription, sourceSlidesBlock } from './providers.js';
import { admission } from './test-admission.js';
import type { Experiment, Input, Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

const video = (id: string, n = 3) => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: Array.from({ length: n }, (_, i) => `w/${id}/slides/${i}.jpg`) }) }) as unknown as Video;
const input = (videoId: string, slides: number[], copySlides: number[] = slides): Input => ({
  videoId, status: 'ready', analysisId: `an-${videoId}`, jobId: null, error: null, coverage: { basis: 'slideshow+caption', observed: slides.length, total: 3, complete: true },
  evidence: slides.map(i => ({ location: `slide:${i}`, observation: `${videoId} frame ${i}` })),
  copy: copySlides.map(slideIndex => ({ slideIndex, state: 'observed_text' as const, text: `${videoId} copy ${slideIndex}` })),
}) as Input;
const brief = { concept: 'c', hook: 'h', character: 'Adult', visualStyle: 'Editorial', caption: '', cta: '', lockedConstraints: [], slides: [0, 1, 2].map(i => ({ role: 'proof', scene: `board scene ${i}`, overlayText: 'x' })) };

function experiment(inputs: Input[], extra: Partial<Experiment> = {}): Experiment {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  return {
    id: 'e', workspaceId: 'w', status: 'generating', generationBasis: 'source-referenced', styleFormula: { medium: 'photograph', density: 'minimal' }, slideCount: 3,
    inputs,
    instructions: { language: 'English', brand: '', audience: '', goal: 'g', direction: 'd', lockedConstraints: [], variables: ['hook'], mode: 'exploration' },
    variants: [{ id: 'v', revision: 1, baselineId: null, changedVariables: [], generationBasis: 'source-referenced', frozenBrief: brief, slides: [] }],
    tasks: [], ...extra,
  } as unknown as Experiment;
}
async function contractFor(e: Experiment, videos: Video[], index: number): Promise<SlideContract> {
  const seen: SlideContract[] = [];
  const deps = {
    findSources: async () => videos,
    generateImage: async () => ({ buffer: Buffer.alloc(600, 1), contentType: 'image/jpeg', costUsd: 0 }),
    readReference: async () => Buffer.from('frame'),
    upload: async () => ({ path: 'stored', sizeBytes: 600 }),
    describeCandidates: async (b: Buffer[]) => b.map((_, i) => ({ id: `c${i}`, description: 'd', overdesigned: false })),
    classify: async () => ({ value: 'c0', confidence: 0.9 }),
    jevScores: async () => ({}),
    generateBriefCandidates: async () => { throw new Error('not used'); },
    verifyStory: async (o: { contract: SlideContract }) => { seen.push(o.contract); return { verdict: 'pass', reasons: [], checks: [], contractHash: o.contract.contractHash, corrected: false, attempts: 1 } as never; },
  };
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index, attempts: 0, charged: 10 } as unknown as Task, deps as never);
  await prepared.execute(admission());
  return seen[0]!;
}

describe('scene and copy follow the selected reference frame', () => {
  test('rotation picks source B for slide 1 and reads B\'s own slide:1', async () => {
    const e = experiment([input('a', [0, 1, 2]), input('b', [0, 1, 2])]);
    const c = await contractFor(e, [video('a'), video('b')], 1);
    expect(c.sourceMap).toMatchObject({ videoId: 'b', sourceIndex: 1, analysisId: 'an-b', observation: 'observed' });
    expect(c.compiledScene).toContain('b frame 1');
    expect(c.observedCopy).toMatchObject({ text: 'b copy 1' });
  });

  test('a source with media but no evidence is never swapped for the next source\'s observation', async () => {
    const e = experiment([input('a', [], []), input('b', [0, 1, 2])]);
    const c = await contractFor(e, [video('a'), video('b')], 0);
    expect(c.sourceMap).toMatchObject({ videoId: 'a', sourceIndex: 0, observation: 'missing' });
    expect(c.compiledScene).not.toContain('b frame');
    expect(c.compiledScene).toContain('board scene 0');
  });

  test('sparse evidence is not compacted: slide 1 stays unobserved and slide 2 keeps its own text', async () => {
    const e = experiment([input('a', [0, 2])]);
    const videos = [video('a')];
    const missing = await contractFor(e, videos, 1);
    expect(missing.sourceMap).toMatchObject({ videoId: 'a', sourceIndex: 1, observation: 'missing' });
    expect(missing.compiledScene).not.toContain('a frame 2');
    expect(missing.observedCopy).toMatchObject({ state: 'unknown', text: null });
    const last = await contractFor(e, videos, 2);
    expect(last.sourceMap).toMatchObject({ sourceIndex: 2, observation: 'observed' });
    expect(last.compiledScene).toContain('a frame 2');
    expect(last.observedCopy).toMatchObject({ text: 'a copy 2' });
  });

  test('a baseline identity frame still resolves scene and source map to the source frame it adapted', async () => {
    const baseline = { id: 'base', revision: 1, baselineId: null, changedVariables: [], generationBasis: 'source-referenced', frozenBrief: brief, slides: [{ index: 0, status: 'done' }, { index: 1, status: 'done', url: 'https://assets.example.test/base/1.jpg', path: 'base/1.jpg' }] };
    const hook = { id: 'v', revision: 1, baselineId: 'base', changedVariables: [{ name: 'hook', value: 'new' }], generationBasis: 'source-referenced', frozenBrief: brief, slides: [] };
    const e = experiment([input('a', [0, 1, 2]), input('b', [0, 1, 2])], { variants: [baseline, hook] } as never);
    const c = await contractFor(e, [video('a'), video('b')], 1);
    expect(c.sourceMap).toMatchObject({ videoId: 'b', sourceIndex: 1, referenceKind: 'baseline', path: 'base/1.jpg' });
    expect(c.compiledScene).toContain('b frame 1');
  });
});

describe('exact lookups', () => {
  const e = experiment([input('a', [0, 2])]);
  test('sourceSlideDescription is exact by videoId and slide index', () => {
    expect(sourceSlideDescription(e, { videoId: 'a', index: 2 })).toBe('a frame 2');
    expect(sourceSlideDescription(e, { videoId: 'a', index: 1 })).toBeNull();
    expect(sourceSlideDescription(e, { videoId: 'zzz', index: 0 })).toBeNull();
    expect(sourceSlideDescription(e, { videoId: 'a', index: null })).toBeNull();
    expect(sourceSlideDescription(e, null)).toBeNull();
  });
  test('the planning board names the exact slide and says when a frame is unobserved', () => {
    const block = sourceSlidesBlock(e);
    expect(block).toContain('storyboard slide 1 adapts carousel 1: slide 0: a frame 0');
    expect(block).toContain('storyboard slide 2 adapts carousel 1: slide 1: no recorded observation');
    expect(block).toContain('storyboard slide 3 adapts carousel 1: slide 2: a frame 2');
    expect(block).not.toContain('slide 1: a frame');
  });
  test('the planning board rotates over every source that owns frames, evidence or not', () => {
    const two = experiment([input('a', [], []), input('b', [0, 1, 2])]);
    const block = sourceSlidesBlock(two);
    expect(block).toContain('storyboard slide 1 adapts carousel 1: slide 0: no recorded observation');
    expect(block).toContain('storyboard slide 2 adapts carousel 2: slide 1: b frame 1');
  });
});
