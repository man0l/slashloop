// SLA-700: the resolved-contract pipeline end to end through the real engine step and prepare(), with fake provider seams.
// Counts every provider call so the 7-clean / 11-worst-case budget for a 3-slide A/B is asserted, not assumed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { step, type EngineDeps } from './engine.js';
import { prepare, type RenderDeps } from './providers.js';
import { generationTasks, reapContractQa } from './contract-flow.js';
import { listSourceFrames } from './contract-pipeline.js';
import type { Experiment } from './schema.js';

const originalEnv = { ...process.env };
beforeEach(() => { process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test'; });
afterEach(() => { process.env = { ...originalEnv }; });

const video = (id: string, n = 3) => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: Array.from({ length: n }, (_, i) => `w/${id}/slides/${i}.jpg`) }) }) as unknown as Video;

const slide = (o: Record<string, unknown> = {}) => ({ overlayText: '', arcLevel: 'none', scene: 'a scene', composition: 'centred', visibleChange: '', ...o });
const rawContract = (o: Record<string, unknown> = {}) => ({
  droppedSourceDefaults: [], droppedLocks: [], subject: 'objects', identity: 'source', identitySheet: '', medium: 'photograph',
  keepSourceImage: true, borrowSourceLook: false, arcAxis: '',
  sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: false })),
  slides: [slide({ overlayText: 'Hook A' }), slide({ overlayText: 'two' }), slide({ overlayText: 'three' })],
  variantB: { variable: 'hook', value: 'Hook B', slides: [] },
  ...o,
});
const qaPass = (n = 3) => ({
  slides: Array.from({ length: n }, (_, index) => ({ index, textSeen: '', overlayExact: true, sceneMatches: true, stateLevel: 'none', mediumMatches: true, lockResults: [] })),
  deck: { identityConsistent: true, sourceLikeness: false, arcVisibleWithoutText: true, notes: '' },
});
const qaFailSlide = (bad: number, n = 3) => { const q = qaPass(n); q.slides[bad]!.overlayExact = false; return q; };

interface Script { contract: unknown; qa: Array<(armSlides: number) => unknown> }

function world(script: Script, overrides: Partial<Experiment['instructions']> = {}) {
  const calls = { contract: 0, images: [] as Array<{ prompt: string; referenceUrl?: string }>, qa: [] as Array<{ images: number; user: string }> };
  const files = new Map<string, Buffer>();
  const render: RenderDeps = {
    findSources: async () => [video('src')],
    generateImage: async o => { calls.images.push({ prompt: o.prompt, referenceUrl: o.referenceUrl }); return { buffer: Buffer.from(`img${calls.images.length}`), contentType: 'image/jpeg', costUsd: 0.01 }; },
    upload: async ({ path, body }) => { files.set(path, body); },
    readReference: async ({ path }) => files.get(path) ?? Buffer.from(`src:${path}`),
    describeCandidates: async () => { throw new Error('describe is removed'); },
    classify: async () => { throw new Error('no judge'); },
    generateBriefCandidates: async () => { throw new Error('no brief candidates'); },
    jevScores: async () => ({}),
    generateContract: async () => { calls.contract++; return script.contract; },
    verifyDeck: async ({ user, images }) => { const next = script.qa[calls.qa.length]; calls.qa.push({ images: images.length, user }); if (!next) throw new Error('unexpected qa call'); return next(images.length); },
  };
  let current = {
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', pipeline: 'contract', generationBasis: 'source-referenced',
    instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: 'Keep the photos, change only the caption', lockedConstraints: ['Faceless: no face visible'],
      sourceDefaults: ['Keep the subject exactly as in the source frame'], variables: ['hook'], mode: 'controlled', ...overrides },
    variantCount: 2, slideCount: 3, maxCredits: 1000, creditsCharged: 0, report: null, error: null, assetPolicy: 'retained', commands: {}, allowPartial: false, createFingerprint: 'x',
    inputs: [{ videoId: 'src', status: 'ready', analysisId: 'an', jobId: null, error: null, coverage: { basis: 'slideshow+caption', observed: 3, total: 3, complete: true }, evidence: [{ location: 'slide:0', observation: 'a photo' }], copy: [] }],
    variants: [], tasks: [{ id: 'b', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment;
  const deps: EngineDeps = {
    load: async () => structuredClone(current),
    save: async (e, charge = 0) => { if (e.version !== current.version) return false; current = structuredClone({ ...e, version: e.version + 1, creditsCharged: e.creditsCharged + charge }); Object.assign(e, current); return true; },
    prepare: (e, t) => prepare(e, t, render), now: () => 1000,
  };
  const api = {
    calls, files, deps,
    get row() { return current; },
    update(fn: (e: Experiment) => void) { const next = structuredClone(current); fn(next); next.version = current.version; current = next; },
    async drain() {
      for (let i = 0; i < 80; i++) {
        await step('w', 'e', deps);
        if (!['planning', 'generating'].includes(current.status)) return;
      }
      throw new Error(`did not settle: ${current.status}`);
    },
    async plan() { await api.drain(); },
    async generate(ids?: string[]) {
      api.update(e => {
        for (const v of e.variants.filter(x => !ids || ids.includes(x.id))) {
          v.frozenBrief = structuredClone(v.brief); v.status = 'generating';
          v.slides = v.brief.slides.map((s, index) => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: s.overlayText ?? '' }));
          e.tasks.push(...generationTasks(v));
        }
        e.status = 'generating';
      });
      await api.drain();
    },
    get providerCalls() { return current.providerCalls ?? {}; },
    get totalCalls() { return Object.values(current.providerCalls ?? {}).reduce((n, x) => n + x, 0); },
  };
  return api;
}

describe('briefs: one contract call', () => {
  test('stores the contract, produces the two arms, and never calls describe/judge/brief candidates', async () => {
    const w = world({ contract: rawContract(), qa: [] });
    await w.plan();
    expect(w.calls.contract).toBe(1);
    expect(w.row.status).toBe('review');
    expect(w.row.contract?.keepSourceImage).toBe(true);
    expect(w.row.variants).toHaveLength(2);
    const [a, b] = w.row.variants;
    expect(a!.brief.hook).toBe('Hook A');
    expect(a!.brief.hook).toBe(a!.brief.slides[0]!.overlayText);
    expect(b!.brief.hook).toBe('Hook B');
    expect(b!.brief.slides[0]!.overlayText).toBe('Hook B');
    expect(b!.changedVariables.map(c => c.name)).toEqual(['hook']);
    expect(w.row.tasks.some(t => t.kind === 'report')).toBe(false);
    expect(w.providerCalls).toEqual({ contract: 1 });
  });

  test('the source default is dropped with a reason and the contract records it', async () => {
    const w = world({ contract: rawContract({ droppedSourceDefaults: [{ default: 'Keep the subject exactly as in the source frame', reason: 'the direction changes the subject' }] }), qa: [] });
    await w.plan();
    expect(w.row.contract?.droppedSourceDefaults).toEqual([{ default: 'Keep the subject exactly as in the source frame', reason: 'the direction changes the subject' }]);
    expect(w.row.contract?.keptSourceDefaults).toEqual([]);
    expect(w.row.contract?.hardLocks.every(l => l.text !== 'Keep the subject exactly as in the source frame')).toBe(true);
  });
});

describe('3-slide hook A/B', () => {
  test('clean run takes 7 provider calls: contract, A 3 renders + QA, B 1 caption edit + QA, 2 slides reused', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    expect(w.providerCalls).toEqual({ contract: 1, render: 3, 'caption-edit': 1, qa: 2 });
    expect(w.totalCalls).toBe(7);
    expect(w.calls.images).toHaveLength(4);
    const [a, b] = w.row.variants;
    expect(a!.status).toBe('done');
    expect(b!.status).toBe('done');
    expect(a!.qaDeck?.verdict).toBe('passed');
    // B slide 1 is a caption-only edit of A slide 1; slides 2..N are A's exact bytes.
    const aSlide0 = a!.slides[0]!;
    const captionEdit = w.calls.images.find(i => i.prompt.includes('Hook B'))!;
    expect(captionEdit.referenceUrl).toBe(aSlide0.url!);
    expect(w.files.get(b!.slides[1]!.path!)).toEqual(w.files.get(a!.slides[1]!.path!));
    expect(w.files.get(b!.slides[2]!.path!)).toEqual(w.files.get(a!.slides[2]!.path!));
    expect(w.files.get(b!.slides[0]!.path!)).not.toEqual(w.files.get(a!.slides[0]!.path!));
  });

  test('edit mode renders every slide from its own source frame, never a shared or last frame', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    const refs = w.calls.images.slice(0, 3).map(i => i.referenceUrl);
    expect(refs).toEqual([0, 1, 2].map(i => `https://assets.example.test/w/src/slides/${i}.jpg`));
  });

  test('no slide numbers reach any image prompt, and the caption is verbatim', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    for (const { prompt } of w.calls.images) expect(prompt).not.toMatch(/\bslide\s*\d|\bslide\s+(one|two|three)\b/i);
    expect(w.calls.images[0]!.prompt).toContain('Hook A');
    expect(w.calls.images[1]!.prompt).toContain('two');
  });

  test('worst case with one repaired slide per arm stays within 11 calls', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaFailSlide(1), () => qaPass(), () => qaFailSlide(0), () => qaPass()] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    expect(w.totalCalls).toBeLessThanOrEqual(11);
    expect(w.providerCalls['render-extra']).toBeGreaterThanOrEqual(1);
  });
});

describe('QA: hard failures get one repair and one re-QA, never downgraded', () => {
  test('a failing slide is re-rendered with the QA text, then re-checked; B reuses the repaired bytes', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaFailSlide(1), () => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    const [a, b] = w.row.variants;
    expect(a!.qaDeck).toMatchObject({ verdict: 'passed', attempts: 2, repaired: [1] });
    const repair = w.calls.images.find(i => /caption must be exactly/i.test(i.prompt));
    expect(repair).toBeDefined();
    expect(w.providerCalls).toMatchObject({ contract: 1, render: 3, 'render-extra': 1, 'caption-edit': 1, qa: 3 });
    expect(w.files.get(b!.slides[1]!.path!)).toEqual(w.files.get(a!.slides[1]!.path!));
  });

  test('B QA failing a slide it reused from A is ignored: no re-render, the bytes stay identical to A', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaPass(), () => qaFailSlide(1)] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    const [a, b] = w.row.variants;
    expect(b!.qaDeck).toMatchObject({ verdict: 'passed', attempts: 1, repaired: [] });
    expect(w.providerCalls).toEqual({ contract: 1, render: 3, 'caption-edit': 1, qa: 2 });
    expect(w.files.get(b!.slides[1]!.path!)).toEqual(w.files.get(a!.slides[1]!.path!));
  });

  test('a failure that survives the repair round fails the arm and the experiment', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaFailSlide(1), () => qaFailSlide(1)] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('failed');
    const a = w.row.variants[0]!;
    expect(a.status).toBe('failed');
    expect(a.qaDeck).toMatchObject({ verdict: 'failed', attempts: 2 });
    expect(a.error).toMatch(/qa_failed/);
    expect(a.error).toMatch(/slide 2/);
  });

  test('in edit mode a missing arc is a warning, not a block', async () => {
    const q = qaPass();
    q.deck.arcVisibleWithoutText = false;
    const w = world({ contract: rawContract({ arcAxis: 'waist width', slides: [slide({ overlayText: 'a', arcLevel: 'low' }), slide({ overlayText: 'b', arcLevel: 'mid' }), slide({ overlayText: 'c', arcLevel: 'high' })], sourceFrameLevels: [{ index: 0, level: 'low', showsPerson: false }, { index: 1, level: 'mid', showsPerson: false }, { index: 2, level: 'high', showsPerson: false }] }), qa: [() => q, () => q] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    expect(w.row.variants[0]!.qaDeck?.warnings.join(' ')).toMatch(/waist width/);
  });
});

describe('frames are picked by arc level, not position', () => {
  test('slides take the source frame at their own level; an unmatched slide is created new', async () => {
    const levels = [{ index: 0, level: 'high', showsPerson: false }, { index: 1, level: 'low', showsPerson: false }, { index: 2, level: 'none', showsPerson: false }];
    const w = world({
      contract: rawContract({ arcAxis: 'size', sourceFrameLevels: levels, slides: [slide({ overlayText: 'a', arcLevel: 'low' }), slide({ overlayText: 'b', arcLevel: 'mid' }), slide({ overlayText: 'c', arcLevel: 'high' })] }),
      qa: [() => qaPass(), () => qaPass()],
    });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    const urls = w.calls.images.map(i => i.referenceUrl);
    expect(urls[0]).toBe('https://assets.example.test/w/src/slides/1.jpg'); // low
    expect(urls[1]).toBeUndefined(); // no mid frame: created new, no last-frame fallback
    expect(urls[2]).toBe('https://assets.example.test/w/src/slides/0.jpg'); // high
  });
});

describe('invented identity', () => {
  const invented = (o: Record<string, unknown> = {}) => rawContract({
    identity: 'invented-consistent', identitySheet: 'a woman with a red braid, 30s, cartoon style', keepSourceImage: false, borrowSourceLook: true, medium: 'cartoon',
    sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    slides: [slide({ overlayText: 'Hook A' }), slide({ overlayText: 'two', visibleChange: 'braid now reaches the waist' }), slide({ overlayText: 'three', visibleChange: 'braid now reaches the knee' })],
    ...o,
  });

  test('slide 1 is rendered fresh with no source person; slides 2..N edit slide 1', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.row.variants[0]!.status).toBe('done');
    const [first, second, third] = w.calls.images;
    expect(first!.referenceUrl).toBeUndefined();
    const anchor = w.row.variants[0]!.slides[0]!.url!;
    expect(second!.referenceUrl).toBe(anchor);
    expect(third!.referenceUrl).toBe(anchor);
    expect(second!.prompt).toContain('braid now reaches the waist');
    expect(first!.prompt).toContain('red braid');
  });

  test('QA is given the source person for the likeness check', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass()] });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.calls.qa[0]!.images).toBe(4);
  });

  test('QA fails the deck when a slide shows the source person, then repairs the chain from slide 1', async () => {
    const likeness = qaPass();
    likeness.deck.sourceLikeness = true;
    const w = world({ contract: invented(), qa: [() => likeness, () => qaPass()] });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.row.variants[0]!.status).toBe('done');
    expect(w.row.variants[0]!.qaDeck).toMatchObject({ verdict: 'passed', attempts: 2, repaired: [1, 2] });
  });
});

describe('source frames', () => {
  test('are indexed in input order and capped', () => {
    const e = { workspaceId: 'w', inputs: [{ videoId: 'a', status: 'ready' }, { videoId: 'b', status: 'ready' }] } as unknown as Experiment;
    const frames = listSourceFrames(e, [video('a', 6), video('b', 6)]);
    expect(frames.map(f => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(frames.slice(0, 4).every(f => f.videoId === 'a')).toBe(true);
    expect(frames.slice(4).every(f => f.videoId === 'b')).toBe(true);
  });
});

describe('a dead slide cannot strand its QA task', () => {
  test('the pending QA of an arm with a failed slide is failed so the run can terminate', async () => {
    const w = world({ contract: rawContract(), qa: [] });
    await w.plan();
    w.update(e => {
      const v = e.variants[0]!;
      v.frozenBrief = structuredClone(v.brief); v.status = 'generating';
      v.slides = v.brief.slides.map((_, index) => ({ index, status: 'done', url: null, path: null, error: null, overlayText: '' }));
      e.tasks.push(...generationTasks(v));
      for (const t of e.tasks.filter(x => x.kind === 'slide')) t.status = 'done';
      e.tasks.find(x => x.kind === 'slide' && x.index === 1)!.status = 'failed';
      e.status = 'generating';
    });
    const changed = reapContractQa(w.row);
    expect(changed).toBe(true);
    expect(w.row.tasks.find(t => t.kind === 'qa')).toMatchObject({ status: 'failed', error: 'deck_incomplete' });
  });
});
