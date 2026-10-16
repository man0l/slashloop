// SLA-700: the resolved-contract pipeline end to end through the real engine step and prepare(), with fake provider seams.
// Counts every provider call so the 7-clean / 11-worst-case budget for a 3-slide A/B is asserted, not assumed.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { step, type EngineDeps } from './engine.js';
import { prepare, type RenderDeps } from './providers.js';
import { applyFeedback, applyRevise, generationTasks, reapContractQa, reviseTargets } from './contract-flow.js';
import { droppedSourceCta, listSourceFrames } from './contract-pipeline.js';
import { applyRetry } from './service.js';
import { experimentProgress } from '../tools/experiments.js';
import { serialize } from './store.js';
import { EDIT_SCENE_GOAL, editSceneDirection, type Experiment } from './schema.js';
import { universalLocks } from './source-format.js';

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
  pools: [{ variable: 'hook', values: [{ value: 'Hook B', slides: [] }] }],
  ...o,
});
const qaPass = (n = 3) => ({
  slides: Array.from({ length: n }, (_, index) => ({ index, textSeen: '', overlayExact: true, sceneMatches: true, stateLevel: 'none', mediumMatches: true, lockResults: [] })),
  deck: { identityConsistent: true, sourceLikeness: false, arcVisibleWithoutText: true, notes: '' },
});
const qaFailSlide = (bad: number, n = 3) => { const q = qaPass(n); q.slides[bad]!.overlayExact = false; return q; };

interface Script { contract: unknown; contracts?: unknown[]; qa: Array<(armSlides: number, user: string) => unknown>; rejectImage?: (prompt: string) => boolean; refusal?: string; composeFails?: boolean }
const FILTER_400 = 'OpenRouter image error 400: {"error":{"message":"The response was filtered due to the prompt triggering our content management policy"}}';

function world(script: Script, overrides: Partial<Experiment['instructions']> = {}) {
  const calls = { contract: 0, contractUsers: [] as string[], images: [] as Array<{ prompt: string; referenceUrl?: string }>, qa: [] as Array<{ images: number; user: string }>, composed: [] as Array<{ text: string; index: number }> };
  const files = new Map<string, Buffer>();
  const render: RenderDeps = {
    findSources: async () => [video('src')],
    generateImage: async o => { calls.images.push({ prompt: o.prompt, referenceUrl: o.referenceUrl }); if (script.rejectImage?.(o.prompt)) throw new Error(script.refusal ?? FILTER_400); return { buffer: Buffer.from(`img${calls.images.length}`), contentType: 'image/jpeg', costUsd: 0.01 }; },
    upload: async ({ path, body }) => { files.set(path, body); },
    composeOverlay: async o => { if (script.composeFails) throw new Error('sharp missing'); calls.composed.push({ text: o.text, index: o.slideIndex }); return { buffer: Buffer.concat([o.buffer, Buffer.from(`+${o.text}`)]), contentType: 'image/jpeg', font: 'Inter Bold', fontSize: 10, lines: [o.text], skipped: [] }; },
    readReference: async ({ path }) => files.get(path) ?? Buffer.from(`src:${path}`),
    describeCandidates: async () => { throw new Error('describe is removed'); },
    classify: async () => { throw new Error('no judge'); },
    generateBriefCandidates: async () => { throw new Error('no brief candidates'); },
    jevScores: async () => ({}),
    generateContract: async ({ user }) => { calls.contractUsers.push(user); calls.contract++; return script.contracts ? script.contracts[Math.min(calls.contract, script.contracts.length) - 1] : script.contract; },
    verifyDeck: async ({ user, images }) => { const next = script.qa[calls.qa.length]; calls.qa.push({ images: images.length, user }); if (!next) throw new Error('unexpected qa call'); return next(images.length, user); },
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
    async revise() { api.update(e => { applyRevise(e, new Date(0)); }); await api.drain(); },
    async feedback(req: Parameters<typeof applyFeedback>[1]) { api.update(e => { applyFeedback(e, req, new Date(0)); }); await api.drain(); },
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

  test('SLA-841: variantCount 1 still plans the two arms and says so, instead of 422 variant_count', async () => {
    const w = world({ contract: rawContract(), qa: [] });
    w.update(e => { e.variantCount = 1; });
    await w.plan();
    expect(w.row.error).toBeNull();
    expect(w.row.status).toBe('review');
    expect(w.row.variants).toHaveLength(2);
    expect(w.row.notices).toContain('The slide contract always compares the direction against at least one alternative, so this run has 2 variants instead of 1.');
  });

  test('the source default is dropped with a reason and the contract records it', async () => {
    const w = world({ contract: rawContract({ droppedSourceDefaults: [{ default: 'Keep the subject exactly as in the source frame', reason: 'the direction changes the subject' }] }), qa: [] });
    await w.plan();
    expect(w.row.contract?.droppedSourceDefaults).toEqual([{ default: 'Keep the subject exactly as in the source frame', reason: 'the direction changes the subject' }]);
    expect(w.row.contract?.keptSourceDefaults).toEqual([]);
    expect(w.row.contract?.hardLocks.every(l => l.text !== 'Keep the subject exactly as in the source frame')).toBe(true);
  });
});

describe('briefs: a short value pool gets one repair', () => {
  const shortB = rawContract({ pools: [{ variable: 'hook', values: [{ value: '', slides: [] }] }] });

  test('the model is re-prompted with the missing field and the repaired contract is used', async () => {
    const w = world({ contract: null, contracts: [shortB, rawContract()], qa: [] });
    await w.plan();
    expect(w.calls.contract).toBe(2);
    expect(w.calls.contractUsers[0]).not.toContain('"repair"');
    expect(w.calls.contractUsers[1]).toContain('Your previous answer was rejected');
    expect(w.row.status).toBe('review');
    expect(w.row.variants[1]!.brief.hook).toBe('Hook B');
    expect(w.providerCalls).toEqual({ contract: 2 });
  });

  test('a second short pool fails with contract_variant_missing after exactly one repair', async () => {
    const w = world({ contract: shortB, qa: [] });
    await w.plan().catch(() => undefined);
    expect(w.calls.contract).toBe(2);
    expect(w.row.tasks.find(t => t.kind === 'briefs')!.error).toContain('contract_variant_missing');
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
    const w = world({ contract: rawContract(), qa: [() => qaFailSlide(1), () => qaFailSlide(1), () => qaPass()] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('failed');
    const a = w.row.variants[0]!;
    expect(a.status).toBe('failed');
    expect(a.qaDeck).toMatchObject({ verdict: 'failed', attempts: 2 });
    expect(a.error).toMatch(/qa_failed/);
    expect(a.error).toMatch(/slide 2/);
    expect(w.row.error).toBe(a.error);
  });

  test('SLA-820: the baseline failing QA terminally does not strand the other arm; its QA job is a terminal verdict', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaFailSlide(1), () => qaFailSlide(1), () => qaPass()] });
    await w.plan();
    await w.generate();
    const [a, b] = w.row.variants;
    expect(a!.qaDeck?.verdict).toBe('failed');
    // Arm B still rendered and was judged, so the A/B can be compared.
    expect(b!.status).toBe('done');
    expect(b!.qaDeck?.verdict).toBe('passed');
    expect(b!.slides.every(s => s.status === 'done' && s.path)).toBe(true);
    expect(w.row.tasks.some(t => t.status === 'pending' || t.status === 'running')).toBe(false);
    expect(w.calls.qa).toHaveLength(3);
    // The run fails only once every arm has settled, with the QA verdict as its reason.
    expect(w.row.status).toBe('failed');
    expect(w.row.error).toMatch(/^qa_failed:/);
    const qaJob = experimentProgress(w.row).retryableJobs.find(j => j.kind === 'qa' && j.status === 'failed')!;
    expect(qaJob).toMatchObject({ terminalQa: true, contentFiltered: false });
    expect(qaJob.advice).toContain('Terminal QA verdict');
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
  test('slides take the source frame at their own level; a slide with no frame is dropped, never rendered new', async () => {
    const levels = [{ index: 0, level: 'high', showsPerson: false }, { index: 1, level: 'low', showsPerson: false }, { index: 2, level: 'none', showsPerson: false }];
    const w = world({
      contract: rawContract({ arcAxis: 'size', sourceFrameLevels: levels, slides: [slide({ overlayText: 'a', arcLevel: 'low' }), slide({ overlayText: 'b', arcLevel: 'mid' }), slide({ overlayText: 'c', arcLevel: 'high' })] }),
      qa: [() => qaPass(2), () => qaPass(2)],
    });
    await w.plan();
    expect(w.row.variants[0]!.brief.slides.map(s => s.overlayText)).toEqual(['a', 'c']);
    expect(w.row.notices?.join(' ')).toMatch(/2 slides instead of 3/);
    await w.generate([w.row.variants[0]!.id]);
    const urls = w.calls.images.map(i => i.referenceUrl);
    expect(urls).toEqual(['https://assets.example.test/w/src/slides/1.jpg', 'https://assets.example.test/w/src/slides/0.jpg']); // low, high: no render without a source frame
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

  test('B QA failing the deck arc on pictures it shares with A is ignored: B slides 2..N stay A\'s bytes', async () => {
    const arc = invented({
      arcAxis: 'braid length',
      slides: [slide({ overlayText: 'Hook A', arcLevel: 'low' }), slide({ overlayText: 'two', arcLevel: 'mid', visibleChange: 'braid now reaches the waist' }), slide({ overlayText: 'three', arcLevel: 'high', visibleChange: 'braid now reaches the knee' })],
    });
    const onArc = () => { const q = qaPass(); ['low', 'mid', 'high'].forEach((l, i) => { q.slides[i]!.stateLevel = l; }); return q; };
    const noArc = onArc();
    noArc.deck.arcVisibleWithoutText = false;
    const w = world({ contract: arc, qa: [onArc, () => noArc] });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    const [a, b] = w.row.variants;
    expect(b!.qaDeck).toMatchObject({ verdict: 'passed', attempts: 1, repaired: [] });
    expect(w.providerCalls).toEqual({ contract: 1, render: 3, 'caption-edit': 1, qa: 2 });
    expect(w.files.get(b!.slides[1]!.path!)).toEqual(w.files.get(a!.slides[1]!.path!));
    expect(w.files.get(b!.slides[2]!.path!)).toEqual(w.files.get(a!.slides[2]!.path!));
  });

  test('an edit of slide 1 rejected by the content filter is retried once with its own scene, not the comparison', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass()], rejectImage: p => p.includes('braid now reaches the knee') });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.row.variants[0]!.status).toBe('done');
    const prompts = w.calls.images.map(c => c.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).not.toContain('braid now reaches the knee');
    expect(prompts[3]).toContain('Change ONLY this: a scene');
    expect(w.calls.images[3]!.referenceUrl).toBe(w.row.variants[0]!.slides[0]!.url!);
    expect(w.providerCalls.render).toBe(4);
  });

  test('a filtered render is retried once with the plain prompt, then fails terminally with a refund and no requeue', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass()], rejectImage: p => p.includes('Create one new') });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    const filtered = w.calls.images.filter(c => c.prompt.includes('Create one new'));
    expect(filtered).toHaveLength(2);
    const task = w.row.tasks.find(t => t.kind === 'slide' && t.status === 'failed')!;
    expect(task.error).toMatch(/^provider_result_rejected:provider_content_filtered/);
    expect(task.attempts).toBe(1);
    expect(task.charged).toBe(0);
    expect(w.row.variants[0]!.status).not.toBe('done');
  });
});

describe('content-filter refusals keep the provider\'s own words (SLA-816)', () => {
  // Synthetic, actual-shaped body: the production wording is unavailable, so only the envelope is real. Longer than every old cut (60/120/200).
  const detail = Array.from({ length: 24 }, (_, i) => `synthetic-detail-${i}`).join(' ');
  const providerMessage = `The response was filtered due to the prompt triggering our content management policy. ${detail}`;
  const RAW = `OpenRouter image error 400: ${JSON.stringify({ error: { message: providerMessage, code: 400 } })}`;
  const invented = () => rawContract({
    identity: 'invented-consistent', identitySheet: 'a woman with a red braid, 30s, cartoon style', keepSourceImage: false, borrowSourceLook: true, medium: 'cartoon',
    sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    slides: [slide({ overlayText: 'Hook A' }), slide({ overlayText: 'two', visibleChange: 'braid now reaches the waist' }), slide({ overlayText: 'three', visibleChange: 'braid now reaches the knee' })],
  });
  const refusedWorld = (overrides: Partial<Experiment['instructions']> = {}, refusal = RAW) =>
    world({ contract: invented(), qa: [() => qaPass()], rejectImage: p => p.includes('Create one new'), refusal }, overrides);

  test('model mode: status, full message, raw text and the plain-prompt retry survive on the job and the slide; terminal and refunded', async () => {
    const w = refusedWorld();
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    const task = w.row.tasks.find(t => t.kind === 'slide' && t.status === 'failed')!;
    const slideDiag = w.row.variants[0]!.slides[task.index!]!.diagnostic;
    const expected = { kind: 'content_filter', status: 400, message: providerMessage, raw: RAW, truncated: false, invocations: 2, plainPromptRetry: true, overlayMode: 'model' };
    expect(providerMessage.length).toBeGreaterThan(200);
    expect(task.diagnostic).toEqual(expected as never);
    expect(slideDiag).toEqual(expected as never);
    expect(task.error).toStartWith('provider_result_rejected:provider_content_filtered');
    expect(task.error).toContain('overlayMode "script"');
    expect(task.error).not.toContain('synthetic-detail');
    expect(w.calls.images.filter(c => c.prompt.includes('Create one new'))).toHaveLength(2);
    expect(task.attempts).toBe(1);
    expect(task.charged).toBe(0);
    expect(w.row.variants[0]!.slides[task.index!]!.status).toBe('failed');
    expect(serialize(w.row).jobs.find(j => j.id === task.id)!.diagnostic).toEqual(expected as never);
    expect(w.row.status).toBe('failed');
  });

  test('script mode: the advice does not point back at script and does not blame a word', async () => {
    const w = refusedWorld({ overlayMode: 'script' });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    const task = w.row.tasks.find(t => t.kind === 'slide' && t.status === 'failed')!;
    expect(task.error).toStartWith('provider_result_rejected:provider_content_filtered');
    expect(task.error).not.toMatch(/Re-create|overlayMode "script" to draw/);
    expect(task.error).toMatch(/scene|reference/);
    expect(task.error).toContain('not a particular word');
    expect(task.diagnostic).toMatchObject({ status: 400, message: providerMessage, raw: RAW, overlayMode: 'script', invocations: 2, plainPromptRetry: true });
    expect(task.charged).toBe(0);
    expect(task.attempts).toBe(1);
    expect(w.calls.composed).toHaveLength(0);
  });

  test('a body that is not JSON is kept whole, and an over-long one is cut at the documented bound and says so', async () => {
    const plain = 'OpenRouter image error 422: content policy violation ' + 'x'.repeat(2500);
    const w = refusedWorld({}, plain);
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    const diag = w.row.tasks.find(t => t.kind === 'slide' && t.status === 'failed')!.diagnostic!;
    expect(diag.status).toBe(422);
    expect(diag.truncated).toBe(true);
    expect(diag.raw).toBe(plain.slice(0, 2000));
    expect(diag.message).toBe(plain.slice(0, 2000));
  });

  test('the job list marks the refusal, carries the diagnostic, and never suggests resending it', async () => {
    const w = refusedWorld();
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    const job = experimentProgress(w.row).retryableJobs.find(j => j.status === 'failed')!;
    expect(job).toMatchObject({ contentFiltered: true, terminalQa: false, diagnostic: { status: 400, message: providerMessage } });
    expect(job.advice).toContain('Change the brief or the reference first');
  });

  test('a manual retry requeues the job and clears the previous refusal until the new attempt answers', async () => {
    const w = refusedWorld();
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    w.update(e => { applyRetry(e, e.tasks.filter(t => t.status === 'failed')); });
    const task = w.row.tasks.find(t => t.kind === 'slide' && t.status === 'pending' && t.attempts === 1)!;
    expect(task.diagnostic).toBeUndefined();
    expect(w.row.variants[0]!.slides[task.index!]!.diagnostic).toBeNull();
  });

  test('ordinary provider failures are not content-filter failures: no diagnostic, no plain-prompt retry', async () => {
    const w = refusedWorld({}, 'OpenRouter image error 500: upstream exploded');
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    expect(w.row.tasks.every(t => !t.diagnostic)).toBe(true);
    expect(w.row.variants[0]!.slides.every(s => !s.diagnostic)).toBe(true);
    expect(w.row.tasks.some(t => /provider_content_filtered/.test(t.error ?? ''))).toBe(false);
    expect(w.calls.images.filter(c => c.prompt.includes('Create one new'))).toHaveLength(w.row.tasks.filter(t => t.kind === 'slide' && t.attempts > 0).length);
  });
});

describe('SLA-841: provider 5xx and timeouts are retryable renders, not terminal render_failed', () => {
  const imageError = (message: string) => world({ contract: rawContract(), qa: [() => qaPass()], rejectImage: () => true, refusal: message });
  const firstSlide = async (message: string) => {
    const w = imageError(message);
    await w.plan();
    await w.generate([w.row.variants[0]!.id]).catch(() => undefined);
    return { w, task: w.row.tasks.find(t => t.kind === 'slide' && t.attempts > 0)! };
  };

  test.each([
    ['502', 'OpenRouter image error 502: {"error":{"message":"Provider returned error","code":502,"metadata":{"provider_name":"Meta"}}}', 'provider_server_502'],
    ['503', 'OpenRouter image error 503: {"error":{"message":"Service unavailable","code":503}}', 'provider_server_503'],
    ['502 with an HTML body', 'OpenRouter image error 502: <html><body>Bad gateway</body></html>', 'provider_server_502'],
    ['timeout', 'The operation timed out after 120000ms', 'timeout'],
  ])('%s is requeued with its provider cause and never reads as render_failed', async (_name, message, cause) => {
    const { w, task } = await firstSlide(message);
    expect(task.status).toBe('pending');
    expect(task.error).toBe(`provider_outcome_unknown:${cause}`);
    expect(task.error).not.toContain('render_failed');
    expect(task.attempts).toBe(1);
    expect(w.row.variants[0]!.slides[task.index!]!.status).toBe('pending');
    expect(w.row.status).toBe('generating');
  });

  test.each([
    ['402', 'OpenRouter image error 402: {"error":{"message":"Insufficient credits","code":402}}', 'credits_exhausted_402', 'failed'],
    ['429', 'OpenRouter image error 429: {"error":{"message":"Rate limit exceeded","code":429}}', 'rate_limited_429 retry_after=30', 'pending'],
  ])('%s keeps its existing classification', async (_name, message, cause, status) => {
    const { task } = await firstSlide(message);
    expect(task.status).toBe(status as never);
    expect(task.error).toBe(`provider_result_rejected:${cause}`);
  });

  test('a non-retryable unknown provider error is still a terminal-shaped render_failed', async () => {
    const { task } = await firstSlide('OpenRouter image error 400: {"error":{"message":"bad aspect ratio","code":400}}');
    expect(task.error).toStartWith('provider_result_rejected:render_failed[');
  });
});

describe('SLA-816: continuing the independent hook after a refused baseline slide', () => {
  test('the hook arm finishes in the same run without replaying the refused slide (SLA-820: no retry needed)', async () => {
    const contract = rawContract({
      identity: 'invented-consistent', identitySheet: 'a woman, cartoon', keepSourceImage: false, borrowSourceLook: true, medium: 'cartoon',
      sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    });
    let image = 0; let refused = 0;
    // Image calls 2 and 3 are the baseline's slide 1 and its single plain-prompt retry.
    const w = world({ contract, qa: [() => qaPass(), () => qaPass()], rejectImage: () => { image++; if (image === 2 || image === 3) { refused++; return true; } return false; } }, { overlayMode: 'script' });
    await w.plan();
    await w.generate();
    const [base, alt] = w.row.variants;
    const refusedTask = w.row.tasks.find(t => t.kind === 'slide' && t.target === base!.id && t.index === 1)!;
    expect(refusedTask).toMatchObject({ status: 'failed', attempts: 1, diagnostic: { invocations: 2, plainPromptRetry: true, overlayMode: 'script' } });
    expect(base!.slides[0]!.status).toBe('done');
    expect(refused).toBe(2);
    const hook = w.row.tasks.find(t => t.kind === 'slide' && t.target === alt!.id && t.index === 0)!;
    expect(hook.status).toBe('done');
    expect(alt!.slides[0]).toMatchObject({ status: 'done', overlay: { mode: 'script' } });
    expect(w.calls.composed).toContainEqual({ text: 'Hook B', index: 0 });
    // The alternate's copy of the refused slide fails closed instead of resending it.
    expect(w.row.tasks.find(t => t.kind === 'slide' && t.target === alt!.id && t.index === 1)!.error).toStartWith('baseline_slide_unavailable');
    expect(w.row.tasks.some(t => t.status === 'pending' || t.status === 'running')).toBe(false);
    expect(w.row.status).toBe('failed');
  });

  test('a refused anchor fails the slides that edit it closed, instead of retrying anchor_slide_missing', async () => {
    const contract = rawContract({
      identity: 'invented-consistent', identitySheet: 'a woman, cartoon', keepSourceImage: false, borrowSourceLook: true, medium: 'cartoon',
      sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    });
    const w = world({ contract, qa: [], rejectImage: p => p.includes('Hook A') });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    const mine = w.row.tasks.filter(t => t.kind === 'slide');
    expect(mine.map(t => t.status)).toEqual(['failed', 'failed', 'failed']);
    expect(mine.slice(1).every(t => t.attempts === 0 && t.error?.startsWith('anchor_slide_unavailable'))).toBe(true);
    expect(w.row.status).toBe('failed');
  });
});

describe('source frames', () => {
  test('are indexed in input order and capped', () => {
    const e = { workspaceId: 'w', slideCount: 6, instructions: {}, inputs: [{ videoId: 'a', status: 'ready' }, { videoId: 'b', status: 'ready' }] } as unknown as Experiment;
    const frames = listSourceFrames(e, [video('a', 6), video('b', 6)]);
    expect(frames.map(f => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(frames.slice(0, 4).every(f => f.videoId === 'a')).toBe(true);
    expect(frames.slice(4).every(f => f.videoId === 'b')).toBe(true);
  });
  test('a closing CTA slide the slide count dropped is never offered as a frame', () => {
    const e = (slideCount: number, preserveSourceCtaSlide?: boolean) => ({ workspaceId: 'w', slideCount, instructions: { preserveSourceCtaSlide }, inputs: [{ videoId: 'a', status: 'ready' }] }) as unknown as Experiment;
    expect(listSourceFrames(e(4), [video('a', 5)]).map(f => f.slideIndex)).toEqual([0, 1, 2, 3]);
    expect(listSourceFrames(e(5), [video('a', 5)]).map(f => f.slideIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(listSourceFrames(e(5, true), [video('a', 5)]).map(f => f.slideIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(droppedSourceCta({ slideCount: 3, instructions: {} } as never, 3)).toBe(false);
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

describe('SLA-797: human feedback regenerates a rendered slideshow', () => {
  const invented = (o: Record<string, unknown> = {}) => rawContract({
    identity: 'invented-consistent', identitySheet: 'one adult man, black tee', keepSourceImage: false, borrowSourceLook: true, medium: 'studio photo',
    sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    slides: [slide({ overlayText: 'Where do you rank?' }), slide({ overlayText: 'MTN', visibleChange: 'softer jaw' }), slide({ overlayText: 'LTN', visibleChange: 'softer jaw, fuller face' })],
    ...o,
  });
  async function rendered(contract = invented(), qa: Script['qa'] = [() => qaPass(), () => qaPass(), () => qaPass(), () => qaPass()]) {
    const w = world({ contract, qa });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.row.variants[0]!.qaDeck?.verdict).toBe('passed');
    return w;
  }

  test('slide feedback re-renders only that slide, from the same anchor, with the note in the prompt, then re-QAs', async () => {
    const w = await rendered();
    const a = w.row.variants[0]!;
    const before = w.calls.images.length;
    const oldPath = a.slides[2]!.path;
    await w.feedback({ variantId: a.id, slides: [{ index: 2, feedback: 'LTN still looks like MTN: make the jaw clearly softer' }] });
    const v = w.row.variants[0]!;
    expect(v.status).toBe('done');
    expect(w.row.status).toBe('review');
    const redo = w.calls.images.slice(before);
    expect(redo).toHaveLength(1);
    expect(redo[0]!.prompt).toContain('USER FEEDBACK');
    expect(redo[0]!.prompt).toContain('LTN still looks like MTN');
    expect(redo[0]!.referenceUrl).toBe(v.slides[0]!.url!);
    expect(v.slides[2]!.path).not.toBe(oldPath);
    expect(v.slides[2]!.feedback).toEqual(['This slide: LTN still looks like MTN: make the jaw clearly softer']);
    expect(v.slides[1]!.feedback ?? null).toBeNull();
    expect(w.calls.qa).toHaveLength(2);
    expect(v.qaDeck).toMatchObject({ verdict: 'passed', attempts: 1 });
    expect(v.feedback).toEqual([{ at: new Date(0).toISOString(), feedback: null, slides: [{ index: 2, feedback: 'LTN still looks like MTN: make the jaw clearly softer' }], redo: [2], previousQa: 'passed' }]);
    expect(w.providerCalls['render-extra']).toBe(1);
  });

  test('slideshow feedback re-renders every slide with the note', async () => {
    const w = await rendered();
    const before = w.calls.images.length;
    await w.feedback({ variantId: w.row.variants[0]!.id, feedback: 'push the downgrade much harder on every tier' });
    const redo = w.calls.images.slice(before);
    expect(redo).toHaveLength(3);
    for (const r of redo) expect(r.prompt).toContain('Whole slideshow: push the downgrade much harder');
    expect(w.row.variants[0]!.feedback?.[0]?.redo).toEqual([0, 1, 2]);
  });

  test('feedback on the anchor slide of an identity chain takes the later slides with it', async () => {
    const w = await rendered();
    const before = w.calls.images.length;
    await w.feedback({ variantId: w.row.variants[0]!.id, slides: [{ index: 0, feedback: 'sharper jaw on the top tier' }] });
    const redo = w.calls.images.slice(before);
    expect(redo).toHaveLength(3);
    expect(redo[0]!.prompt).toContain('sharper jaw on the top tier');
    expect(redo[1]!.prompt).not.toContain('sharper jaw on the top tier');
    expect(redo[1]!.referenceUrl).toBe(w.row.variants[0]!.slides[0]!.url!);
  });

  test('the note survives into a QA repair of the same slide', async () => {
    const w = await rendered(invented(), [() => qaPass(), () => qaFailSlide(1), () => qaPass()]);
    await w.feedback({ variantId: w.row.variants[0]!.id, slides: [{ index: 1, feedback: 'fuller face' }] });
    const repair = w.calls.images.find(i => i.prompt.includes('FIX FROM QA'))!;
    expect(repair.prompt).toContain('USER FEEDBACK');
    expect(repair.prompt).toContain('fuller face');
    expect(w.row.variants[0]!.qaDeck).toMatchObject({ verdict: 'passed', attempts: 2 });
  });

  test('a second round keeps the earlier note, newest last', async () => {
    const w = await rendered();
    const id = w.row.variants[0]!.id;
    await w.feedback({ variantId: id, slides: [{ index: 2, feedback: 'softer jaw' }] });
    await w.feedback({ variantId: id, slides: [{ index: 2, feedback: 'now hair too flat, keep jaw' }] });
    const last = w.calls.images.at(-1)!.prompt;
    expect(last).toContain('(1) This slide: softer jaw (2) This slide: now hair too flat, keep jaw');
    expect(last).toContain('the last one wins');
    expect(w.row.variants[0]!.feedback).toHaveLength(2);
  });

  test('a failed arm can be regenerated from feedback: its failed jobs are replaced, and it completes', async () => {
    const w = world({ contract: invented(), qa: [() => qaFailSlide(1), () => qaFailSlide(1), () => qaPass()] });
    await w.plan();
    await w.generate([w.row.variants[0]!.id]);
    expect(w.row.status).toBe('failed');
    await w.feedback({ variantId: w.row.variants[0]!.id, slides: [{ index: 1, feedback: 'make MTN clearly softer than HTN' }] });
    expect(w.row.status).toBe('review');
    expect(w.row.variants[0]!.status).toBe('done');
    expect(w.row.tasks.some(t => t.status === 'failed')).toBe(false);
    expect(w.row.variants[0]!.feedback?.[0]?.previousQa).toBe('failed');
  });

  test('feedback on a slide arm B reused from A renders it instead of copying A again', async () => {
    const w = world({ contract: rawContract(), qa: [() => qaPass(), () => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    const [a, b] = w.row.variants;
    expect(w.files.get(b!.slides[1]!.path!)).toEqual(w.files.get(a!.slides[1]!.path!));
    await w.feedback({ variantId: b!.id, slides: [{ index: 1, feedback: 'brighter light' }] });
    const nb = w.row.variants[1]!;
    expect(nb.slides[1]!.provider).toBe('openrouter');
    expect(w.files.get(nb.slides[1]!.path!)).not.toEqual(w.files.get(a!.slides[1]!.path!));
    expect(w.row.status).toBe('completed');
  });

  test('feedback on arm B\'s anchor re-renders its identity chain from B\'s new anchor, never A\'s copies', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass(), () => qaPass(), () => qaPass()] });
    await w.plan();
    await w.generate();
    const before = w.calls.images.length;
    await w.feedback({ variantId: w.row.variants[1]!.id, slides: [{ index: 0, feedback: 'older looking man' }] });
    const [a, b] = w.row.variants;
    const redo = w.calls.images.slice(before);
    expect(redo).toHaveLength(3);
    expect(redo[1]!.referenceUrl).toBe(b!.slides[0]!.url!);
    expect(b!.slides.every(s => s.provider === 'openrouter')).toBe(true);
    expect(w.files.get(b!.slides[2]!.path!)).not.toEqual(w.files.get(a!.slides[2]!.path!));
  });

  test('refusals: active run, ungenerated variant, unknown slide, legacy pipeline, job in flight', async () => {
    const w = world({ contract: invented(), qa: [() => qaPass()] });
    await w.plan();
    const [a, b] = w.row.variants;
    const code = (fn: () => void) => { try { fn(); return null; } catch (err) { return (err as { code?: string }).code; } };
    const e = () => structuredClone(w.row);
    expect(code(() => applyFeedback(e(), { variantId: a!.id, feedback: 'x' }))).toBe('variant_not_generated');
    await w.generate([a!.id]);
    expect(code(() => applyFeedback(e(), { variantId: b!.id, feedback: 'x' }))).toBe('variant_not_generated');
    expect(code(() => applyFeedback(e(), { variantId: 'nope', feedback: 'x' }))).toBe('variant_not_found');
    expect(code(() => applyFeedback(e(), { variantId: a!.id, slides: [{ index: 5, feedback: 'x' }] }))).toBe('invalid_slide');
    expect(code(() => applyFeedback({ ...e(), status: 'generating' }, { variantId: a!.id, feedback: 'x' }))).toBe('experiment_active');
    expect(code(() => applyFeedback({ ...e(), pipeline: null }, { variantId: a!.id, feedback: 'x' }))).toBe('feedback_unsupported');
    const stuck = e(); stuck.status = 'paused'; stuck.tasks.push({ id: 'u', kind: 'slide', target: a!.id, index: 1, status: 'unknown', attempts: 4, charged: 0 });
    expect(code(() => applyFeedback(stuck, { variantId: a!.id, feedback: 'x' }))).toBe('variant_in_flight');
  });
});

describe('SLA-787: overlayMode "script" on the contract pipeline', () => {
  const script = () => ({ contract: rawContract(), qa: [() => qaPass(), () => qaPass()] });

  test('no overlay word reaches any image prompt, and the composed bytes carry the words', async () => {
    const w = world(script(), { overlayMode: 'script' });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    for (const { prompt } of w.calls.images) expect(prompt).not.toMatch(/Hook A|Hook B|\btwo\b|\bthree\b/);
    expect(w.calls.images[0]!.prompt).toContain('no caption, no words');
    const [a] = w.row.variants;
    expect(w.files.get(a!.slides[0]!.path!)!.toString()).toContain('+Hook A');
    expect(w.files.get(a!.slides[0]!.path!.replace(/\.jpg$/, '.base.jpg'))!.toString()).not.toContain('+');
  });

  test('arm B caption edit composes onto the text-free base with no model call', async () => {
    const w = world(script(), { overlayMode: 'script' });
    await w.plan();
    await w.generate();
    const [a, b] = w.row.variants;
    expect(w.providerCalls['caption-edit']).toBeUndefined();
    expect(w.calls.images).toHaveLength(3);
    const bytes = w.files.get(b!.slides[0]!.path!)!.toString();
    expect(bytes).toContain('+Hook B');
    expect(bytes).not.toContain('Hook A');
    expect(w.files.get(a!.slides[0]!.path!)!.toString()).toContain('+Hook A');
  });

  test('a compositor failure fails the slide closed with overlay_compose_failed', async () => {
    const w = world({ ...script(), composeFails: true }, { overlayMode: 'script' });
    await w.plan();
    await w.generate().catch(() => {});
    expect(JSON.stringify(w.row.tasks)).toContain('overlay_compose_failed');
    expect(w.row.variants.every(v => v.slides.every(x => x.status !== 'done'))).toBe(true);
  });

  test('model mode is unchanged: the caption is in the prompt and nothing is composed', async () => {
    const w = world(script());
    await w.plan();
    await w.generate();
    expect(w.calls.composed).toHaveLength(0);
    expect(w.calls.images[0]!.prompt).toContain('Hook A');
  });
});

describe('SLA-811: a QA-failed experiment is retried with a model-revised brief', () => {
  const FAIL = () => qaFailSlide(1);
  const revisedContract = () => rawContract({
    slides: [slide({ overlayText: 'Hook A' }), slide({ overlayText: 'two', scene: 'a clearer scene' }), slide({ overlayText: 'three' })],
  });
  async function failed(qa: Script['qa'] = [FAIL, FAIL, () => qaPass(), () => qaPass(), () => qaPass()]) {
    const w = world({ contract: rawContract(), contracts: [rawContract(), revisedContract()], qa });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('failed');
    return w;
  }

  test('the contract model is called again with the failures and the rejected briefs, and the arms are re-rendered and re-checked', async () => {
    const w = await failed();
    const before = w.calls.images.length;
    await w.revise();
    expect(w.calls.contract).toBe(2);
    const sent = JSON.parse(w.calls.contractUsers[1]!);
    expect(sent.revision.why).toMatch(/FAILED the quality check/);
    expect(sent.revision.arms[0].failures).toBeDefined();
    expect(JSON.stringify(sent.revision.arms[0].failures)).toMatch(/slide 2|1/);
    expect(sent.revision.arms[0].slides).toHaveLength(3);
    expect(w.calls.contractUsers[0]).not.toContain('FAILED the quality check');
    expect(w.calls.images.length).toBeGreaterThan(before);
    expect(w.row.status).toBe('completed');
    expect(w.row.variants.map(v => v.qaDeck?.verdict)).toEqual(['passed', 'passed']);
    expect(w.row.variants[0]!.brief.slides[1]!.scene).toBe('a clearer scene');
    expect(w.row.revisions).toHaveLength(1);
    expect(w.row.tasks.filter(t => t.kind === 'revise')).toHaveLength(1);
  });

  test('still failing after the revision leaves the experiment failed and revisable until the limit', async () => {
    const w = await failed([FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]);
    await w.revise();
    expect(w.row.status).toBe('failed');
    await w.revise();
    expect(w.row.status).toBe('failed');
    expect(w.row.revisions).toHaveLength(2);
    expect(() => reviseTargets(w.row)).toThrow(/revised 2 times/);
  });

  test('refuses what cannot be revised', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (err) { return (err as { code?: string }).code; } return null; };
    const base = { pipeline: 'contract', status: 'failed', tasks: [], variants: [{ id: 'a', qaDeck: { verdict: 'failed', failures: {} } }], revisions: [] } as unknown as Experiment;
    expect(code(() => reviseTargets({ ...base, pipeline: null } as Experiment))).toBe('revise_unsupported');
    expect(code(() => reviseTargets({ ...base, status: 'completed' } as Experiment))).toBe('not_revisable');
    expect(code(() => reviseTargets({ ...base, status: 'generating' } as Experiment))).toBe('experiment_active');
    expect(code(() => reviseTargets({ ...base, tasks: [{ id: 't', kind: 'slide', status: 'pending', attempts: 0, charged: 0 }] } as unknown as Experiment))).toBeNull();
    expect(code(() => reviseTargets({ ...base, tasks: [{ id: 't', kind: 'slide', status: 'running', attempts: 1, charged: 0 }] } as unknown as Experiment))).toBe('provider_outcome_unknown');
    expect(code(() => reviseTargets({ ...base, variants: [{ id: 'a', qaDeck: { verdict: 'passed', failures: {} } }] } as unknown as Experiment))).toBe('no_qa_failure');
    expect(reviseTargets(base)).toHaveLength(1);
  });

  test('the experiment does not complete while the revise task is open', async () => {
    const w = await failed();
    w.update(e => { applyRevise(e, new Date(0)); });
    expect(w.row.status).toBe('generating');
    expect(w.row.tasks.some(t => t.kind === 'revise' && t.status === 'pending')).toBe(true);
  });
});

describe('scene variable: arm B edits every baseline slide into another setting', () => {
  const OPENER = 'Edit the attached 9:16 frame. Keep the SAME person, outfit, pose, medium, lighting and camera. Change ONLY the setting and props to the slide scene.';
  const STREET = 'a rainy street at night';
  const sceneContract = (o: Record<string, unknown> = {}) => rawContract({ pools: [{ variable: 'scene', values: [{ value: STREET, slides: [] }] }], ...o });
  const qaScene = (n = 3, changed = true) => { const q = qaPass(n); q.slides.forEach(s => { (s as Record<string, unknown>).settingChanged = changed; }); return q; };
  const scenario = (qa: Script['qa'] = [() => qaPass(), () => qaScene()]) => ({ contract: sceneContract(), qa });
  const vars: Partial<Experiment['instructions']> = { variables: ['scene'] };

  test('plans arm B as arm A with only each slide\'s scene replaced; the overlay copy stays locked', async () => {
    const w = world(scenario(), vars);
    await w.plan();
    expect(w.row.error).toBeNull();
    expect(w.row.status).toBe('review');
    const [a, b] = w.row.variants;
    expect(w.row.contract?.keepSourceImage).toBe(false);
    expect(b!.brief.slides.map(s => s.scene)).toEqual([STREET, STREET, STREET]);
    expect(a!.brief.slides.map(s => s.scene)).toEqual(['a scene', 'a scene', 'a scene']);
    expect(b!.brief.slides.map(s => s.overlayText)).toEqual(a!.brief.slides.map(s => s.overlayText));
    expect(b!.brief.hook).toBe(a!.brief.hook);
    expect(b!.changedVariables.map(c => c.name)).toEqual(['scene']);
    expect(b!.changedVariables[0]!.value).toBe(STREET);
  });

  test('the user\'s own scenes win over the model\'s, one per slide', async () => {
    const w = world(scenario(), { ...vars, sceneOverrides: ['a beach', 'a kitchen', 'a train'] });
    await w.plan();
    expect(w.row.variants[1]!.brief.slides.map(s => s.scene)).toEqual(['a beach', 'a kitchen', 'a train']);
  });

  // SLA-881: a draft stored like 278afe69 (pre-fix prose, no locks) still plans arm A from the source deck.
  test('an edit-mode scene draft plans arm A from the source: the new setting is the alternate\'s only, workspace locks on', async () => {
    const LOCKER = 'a gym locker room';
    const w = world(scenario(), { ...vars, goal: EDIT_SCENE_GOAL, direction: `Scene: ${LOCKER}. Change only the setting, props and action; keep the same person.`, lockedConstraints: [], sceneOverrides: [LOCKER] });
    await w.plan();
    const sent = JSON.parse(w.calls.contractUsers[0]!) as { direction: string; locks: Array<{ lock: string; origin: string }> };
    expect(sent.direction).toBe(editSceneDirection([LOCKER]));
    expect(sent.direction).not.toContain(`Scene: ${LOCKER}`);
    expect(sent.direction.indexOf(LOCKER)).toBeGreaterThan(sent.direction.indexOf('alternate only'));
    expect(sent.locks.map(l => l.lock)).toEqual(universalLocks());
    expect(sent.locks.every(l => l.origin === 'workspace')).toBe(true);
    expect(w.row.contract?.hardLocks.map(l => l.text)).toEqual(universalLocks());
  });

  test('a create-mode scene test keeps its own direction and locks', async () => {
    const w = world(scenario(), vars);
    await w.plan();
    const sent = JSON.parse(w.calls.contractUsers[0]!) as { direction: string; locks: Array<{ lock: string }> };
    expect(sent.direction).toBe('Keep the photos, change only the caption');
    expect(sent.locks.map(l => l.lock)).toEqual(['Faceless: no face visible']);
  });

  test('the model\'s per-slide re-staging of the user\'s setting keeps each slide\'s own outfit and pose', async () => {
    const restaged = ['locker room, shirtless by the benches', 'locker room, grey hoodie by the lockers', 'locker room, blue tee at the mirror'];
    const w = world({ ...scenario(), contract: sceneContract({ pools: [{ variable: 'scene', values: [{ value: 'a gym locker room', slides: restaged.map(scene => slide({ scene, composition: '' })) }] }] }) }, { ...vars, sceneOverrides: ['a gym locker room'] });
    await w.plan();
    expect(w.row.variants[1]!.brief.slides.map(s => s.scene)).toEqual(restaged);
    expect(w.row.variants[0]!.brief.slides.map(s => s.scene)).toEqual(['a scene', 'a scene', 'a scene']);
  });

  test('a scene count that is neither one nor the slide count fails the plan with contract_scene_count', async () => {
    const w = world(scenario(), { ...vars, sceneOverrides: ['a beach', 'a kitchen'] });
    await w.plan().catch(() => {});
    expect(JSON.stringify(w.row.tasks)).toContain('contract_scene_count');
    expect(w.row.variants).toHaveLength(0);
  });

  test('every B slide is an edit of its own baseline picture, one render each (6 renders, 2 QA, 1 contract)', async () => {
    const w = world(scenario(), vars);
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    expect(w.providerCalls).toEqual({ contract: 1, render: 6, qa: 2 });
    const [a, b] = w.row.variants;
    const bImages = w.calls.images.slice(3);
    expect(bImages).toHaveLength(3);
    bImages.forEach((img, i) => {
      expect(img.prompt.startsWith(OPENER)).toBe(true);
      expect(img.referenceUrl).toBe(a!.slides[i]!.url!);
      expect(img.prompt).toContain(`SCENE for this image: ${STREET}`);
      expect(img.prompt).toContain(['Hook A', 'two', 'three'][i]!);
    });
    expect(b!.slides.every(s => s.provider === 'openrouter')).toBe(true);
    expect(w.files.get(b!.slides[1]!.path!)).not.toEqual(w.files.get(a!.slides[1]!.path!));
  });

  test('the source-label rule rides on the edit opener, like the other edit prompts', async () => {
    const w = world(scenario(), vars);
    await w.plan();
    await w.generate();
    expect(w.calls.images[3]!.prompt.split('\n')[1]).toMatch(/Erase ONLY the marks listed for removal|Do not copy any text, logo or watermark/);
  });

  test('QA gets the baseline slides, keeps identity on, and expects the setting to change', async () => {
    const w = world(scenario(), vars);
    await w.plan();
    await w.generate();
    const [qaA, qaB] = w.calls.qa;
    expect(qaA!.user).toContain('true; not applicable');
    expect(qaA!.user).not.toContain("baseline deck's slides");
    expect(qaB!.user).toContain("baseline deck's slides");
    expect(qaB!.user).toContain('clearly different from the matching baseline slide');
    expect(qaB!.user).toContain('the same person or character as in the baseline slides');
    expect(qaB!.images).toBeGreaterThanOrEqual(qaA!.images + 3);
  });

  test('a slide whose setting did not change fails QA, is re-rendered once with the QA text, then passes', async () => {
    const bad = () => { const q = qaScene(); (q.slides[1] as Record<string, unknown>).settingChanged = false; return q; };
    const w = world(scenario([() => qaPass(), bad, () => qaScene()]), vars);
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    expect(w.providerCalls['render-extra']).toBe(1);
    const fix = w.calls.images.at(-1)!;
    expect(fix.prompt.startsWith(OPENER)).toBe(true);
    expect(fix.prompt).toContain('FIX FROM QA');
    expect(fix.prompt).toContain('the setting, props and action must differ from the baseline slide');
  });

  test('a setting that stays unchanged after the repair round fails the arm', async () => {
    const same = () => qaScene(3, false);
    const w = world(scenario([() => qaPass(), same, same, same]), vars);
    await w.plan();
    await w.generate().catch(() => {});
    expect(w.row.status).toBe('failed');
  });

  test('script mode: B edits the text-free base of the baseline picture and draws its own copy afterwards', async () => {
    const w = world(scenario(), { ...vars, overlayMode: 'script' });
    await w.plan();
    await w.generate();
    expect(w.row.status).toBe('completed');
    const [a, b] = w.row.variants;
    const bImages = w.calls.images.slice(3);
    expect(bImages[0]!.referenceUrl).toBe(`https://assets.example.test/${a!.slides[0]!.path!.replace(/\.jpg$/, '.base.jpg')}`);
    for (const { prompt } of w.calls.images) expect(prompt).not.toMatch(/Hook A|\btwo\b|\bthree\b/);
    expect(w.files.get(b!.slides[0]!.path!)!.toString()).toContain('+Hook A');
  });

  test('estimate_experiment(generate) equals what the run charges: one render per slide plus a QA per arm', async () => {
    const { CREDIT_COSTS } = await import('../lib/credits.js');
    const real = { ...(await import('../lib/credits.js')) };
    mock.module('../lib/credits.js', () => ({ ...real, creditBalance: async () => ({ total: 9999 }) }));
    try {
      const { estimate } = await import('./service.js');
      const w = world(scenario(), vars);
      await w.plan();
      const est = await estimate(w.row, 'generate');
      const before = w.row.creditsCharged;
      await w.generate();
      const charged = w.row.creditsCharged - before;
      expect(est.generationCredits).toBe(6 * CREDIT_COSTS.experimentSlide + 2 * CREDIT_COSTS.experimentPlanningCall);
      expect(est.totalCredits).toBe(charged);
      expect(est.pricing.slide).toBe(CREDIT_COSTS.experimentSlide);
    } finally { mock.module('../lib/credits.js', () => ({ ...real })); }
  });

  test('estimate_experiment(plan) quotes the worst-case generation ceiling for every requested variant', async () => {
    const { CREDIT_COSTS } = await import('../lib/credits.js');
    const real = { ...(await import('../lib/credits.js')) };
    mock.module('../lib/credits.js', () => ({ ...real, creditBalance: async () => ({ total: 9999 }) }));
    try {
      const { estimate } = await import('./service.js');
      const w = world(scenario(), vars);
      w.update(e => { e.variantCount = 9; });
      const est = await estimate(w.row, 'plan') as Awaited<ReturnType<typeof estimate>> & { projectedGenerationCredits?: number; upperBound?: boolean };
      expect(est.upperBound).toBe(true);
      expect(est.projectedGenerationCredits).toBe(9 * (w.row.slideCount * CREDIT_COSTS.experimentSlide + CREDIT_COSTS.experimentPlanningCall));
    } finally { mock.module('../lib/credits.js', () => ({ ...real })); }
  });
});

describe('SLA-867: a morph (ladder) deck end to end', () => {
  const grade = (jaw: number, cheeks: number) => [{ attribute: 'jaw definition', grade: jaw }, { attribute: 'cheek fullness', grade: cheeks }];
  const morphSlide = (overlayText: string, jaw: number, cheeks: number) => slide({ overlayText, scene: 'studio portrait, seamless gray backdrop, even light', morph: grade(jaw, cheeks) });
  const contract = rawContract({
    subject: 'person', identity: 'invented-consistent', identitySheet: 'an invented man, wavy black hair, hazel eyes, black t-shirt', keepSourceImage: false,
    sourceFrameLevels: [0, 1, 2].map(index => ({ index, level: 'none', showsPerson: true })),
    morph: { axis: 'face softens', attributes: ['jaw definition', 'cheek fullness'] },
    slides: [morphSlide('CHAD\n2% of population', 4, 0), morphSlide('HTN\n20% of population', 2, 2), morphSlide('SUB 3\n12% of population', 0, 4)],
    pools: [{ variable: 'morph', values: [{ value: 'stops halfway', slides: [morphSlide('', 4, 0), morphSlide('', 3, 1), morphSlide('', 2, 2)] }] }],
  });
  // A judge that sees every listed morph check and passes it, as one that sees the change would.
  const judge = (pass: boolean) => (n: number, user: string) => {
    const q = qaPass(n) as unknown as { slides: Array<Record<string, unknown>> };
    const listed = JSON.parse(user.match(/Checks: (\[.*\])\.\n/)![1]!) as Array<{ index: number; checks: string[] }>;
    q.slides.forEach(x => { x.samePerson = true; x.morphChecks = []; });
    for (const x of listed) q.slides[x.index]!.morphChecks = x.checks.map(check => ({ check, pass, note: pass ? '' : 'no visible change' }));
    return q;
  };
  const morphWorld = (qa: Script['qa']) => world({ contract, qa }, { variables: ['morph'], direction: 'Reproduce the ladder with one invented man', lockedConstraints: [], sourceDefaults: [] });

  test('labels are drawn in code, prompts carry no valuation word, and later slides edit the arm\'s own slide 1', async () => {
    const w = morphWorld([judge(true), judge(true)]);
    await w.plan();
    expect(w.row.status).toBe('review');
    expect(w.row.contract?.morph?.attributes).toEqual(['jaw definition', 'cheek fullness']);
    const [a, b] = w.row.variants;
    expect(b!.changedVariables.map(c => c.name)).toEqual(['morph']);
    expect(b!.brief.slides.map(s => s.overlayText)).toEqual(a!.brief.slides.map(s => s.overlayText));
    await w.generate();
    expect(w.row.status).toBe('completed');
    for (const { prompt } of w.calls.images) {
      expect(prompt).not.toMatch(/chad|htn|sub 3|population|%/i);
      expect(prompt).not.toMatch(/IGNORE/);
    }
    expect(w.calls.composed.map(c => c.text)).toContain('CHAD\n2% of population');
    const later = w.calls.images.filter(i => i.prompt.includes('MORPH:'));
    expect(later).toHaveLength(4);
    // Slide N is an edit of its arm's slide 1 (the hero), never of slide N-1, and of its text-free base: no label as pixels.
    // B's slide 1 is a copy of A's picture, base included.
    const heroes = w.row.variants.map(v => `https://assets.example.test/${v.slides[0]!.path!.replace(/\.jpg$/, '.base.jpg')}`);
    expect(later.every(i => heroes.includes(i.referenceUrl ?? ''))).toBe(true);
    expect(new Set(later.map(i => i.referenceUrl)).size).toBe(2);
    const [ha, hb] = w.row.variants.map(v => v.slides[0]!.path!.replace(/\.jpg$/, '.base.jpg'));
    expect(w.files.get(hb!)!.equals(w.files.get(ha!)!)).toBe(true);
    expect(w.files.get(ha!)!.toString()).not.toContain('+');
    // Arm B reuses arm A's slide 1: 3 + 2 renders, one candidate each, and the QA prompt carried the morph checks.
    expect(w.calls.images).toHaveLength(5);
    expect(w.calls.qa[0]!.user).toContain('jaw definition has visibly changed from slide 1');
  });

  test('a morph check the judge does not see fails the arm', async () => {
    const w = morphWorld([judge(false), judge(false), judge(false), judge(false)]);
    await w.plan();
    await w.generate();
    expect(JSON.stringify(w.row.variants.map(v => v.qaDeck))).toContain('has visibly changed from slide 1');
  });
});

describe('multiplication (SLA-866): hook, character, angle and scene alternates edit the baseline, never a fresh opener', () => {
  const FRESH = 'Create one new 9:16 social carousel image';
  const angleSlides = (tag: string) => ['one', 'two', 'three'].map(n => slide({ overlayText: `${tag} ${n}` }));
  const pools = () => [
    { variable: 'hook', values: [{ value: 'Hook B', slides: [] }, { value: 'Hook C', slides: [] }] },
    { variable: 'character', values: [{ value: 'a red-haired woman in her fifties', slides: [] }, { value: 'a teenage boy with glasses', slides: [] }] },
    { variable: 'concept', values: [{ value: 'angle one', slides: angleSlides('A1') }, { value: 'angle two', slides: angleSlides('A2') }] },
    { variable: 'scene', values: [{ value: 'a rainy street', slides: [] }, { value: 'a crowded train', slides: [] }] },
  ];
  const contract = () => rawContract({ identity: 'invented-consistent', identitySheet: 'a tall man in his thirties', subject: 'person', keepSourceImage: false, pools: pools() });
  const qa = (n = 8) => Array.from({ length: n }, () => () => { const q = qaPass(); q.slides.forEach(s => { (s as Record<string, unknown>).settingChanged = true; }); return q; });
  const vars: Partial<Experiment['instructions']> = { variables: ['hook', 'character', 'concept', 'scene'], mode: 'exploration' };
  const run = async (overrides: Partial<Experiment['instructions']> = {}, variantCount = 6) => {
    const w = world({ contract: contract(), qa: qa(variantCount) }, { ...vars, ...overrides });
    w.update(e => { e.variantCount = variantCount; });
    await w.plan();
    await w.generate();
    return w;
  };

  test.each([['model', {}], ['script', { overlayMode: 'script' as const }]])('%s mode: no alternate prompt is a fresh render and every alternate render edits a baseline picture', async (_m, o) => {
    const w = await run(o);
    expect(w.row.error).toBeNull();
    expect(w.row.status).toBe('completed');
    expect(w.row.variants).toHaveLength(6);
    const baselineUrls = new Set(w.row.variants[0]!.slides.map(s => s.url));
    const baselineBases = new Set(w.row.variants[0]!.slides.map(s => `https://assets.example.test/${s.path!.replace(/\.jpg$/, '.base.jpg')}`));
    const alternateImages = w.calls.images.slice(3);
    expect(alternateImages.length).toBeGreaterThan(0);
    for (const img of alternateImages) {
      expect(img.prompt).not.toContain(FRESH);
      expect(img.referenceUrl).toBeDefined();
      expect(baselineUrls.has(img.referenceUrl!) || baselineBases.has(img.referenceUrl!)).toBe(true);
    }
  });

  test('a character alternate names the new person and keeps the rest of the frame; a scene alternate keeps the person', async () => {
    const w = await run();
    const characterPrompts = w.calls.images.filter(i => i.prompt.includes('NEW PERSON'));
    const scenePrompts = w.calls.images.filter(i => i.prompt.includes('Change ONLY the setting and props to the slide scene'));
    expect(characterPrompts.length).toBeGreaterThanOrEqual(3);
    expect(characterPrompts.some(p => p.prompt.includes('a red-haired woman in her fifties'))).toBe(true);
    expect(characterPrompts.every(p => !p.prompt.startsWith('Create one new 9:16'))).toBe(true);
    expect(scenePrompts.length).toBeGreaterThanOrEqual(3);
    expect(scenePrompts.every(p => p.prompt.includes('Keep the SAME person') && !p.prompt.includes('NEW PERSON'))).toBe(true);
  });

  test('angle and hook alternates are caption edits of the baseline picture, one call per slide in model mode', async () => {
    const w = await run();
    const captions = w.calls.images.filter(i => i.prompt.startsWith('Edit the attached image. Keep everything identical'));
    expect(captions.length).toBeGreaterThanOrEqual(1);
    expect(w.providerCalls['caption-edit']).toBe(captions.length);
  });

  test.each([['model', {} as Partial<Experiment['instructions']>], ['script', { overlayMode: 'script' } as Partial<Experiment['instructions']>]])('%s mode: estimate_experiment(generate) equals the credits charged', async (_m, o) => {
    const { CREDIT_COSTS } = await import('../lib/credits.js');
    const real = { ...(await import('../lib/credits.js')) };
    mock.module('../lib/credits.js', () => ({ ...real, creditBalance: async () => ({ total: 9999 }) }));
    try {
      const { estimate } = await import('./service.js');
      const w = world({ contract: contract(), qa: qa(6) }, { ...vars, ...o });
      w.update(e => { e.variantCount = 6; });
      await w.plan();
      const est = await estimate(w.row, 'generate');
      const before = w.row.creditsCharged;
      await w.generate();
      const charged = w.row.creditsCharged - before;
      expect(est.totalCredits).toBe(charged);
      if (o.overlayMode === 'script') expect(est.generationCredits).toBeLessThan(18 * CREDIT_COSTS.experimentSlide + 6 * CREDIT_COSTS.experimentPlanningCall);
    } finally { mock.module('../lib/credits.js', () => ({ ...real })); }
  });
});
