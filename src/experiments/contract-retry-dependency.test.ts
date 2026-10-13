// SLA-818: retrying a contract run whose baseline keeps a refused slide. The scope is the one a caller prices from the job list:
// every pending job (baseline slides and QA, alternate slides and QA), not the refused job. The run goes through the real engine
// step, the service retry command and a real SQLite row, so what is asserted is what a later tick would read back.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Video } from '@prisma/client';
import type { RawStatement } from '../store.js';
import { step, type EngineDeps } from './engine.js';
import { prepare, type RenderDeps } from './providers.js';
import { contractEligible, generationTasks } from './contract-flow.js';
import { retryJobs } from './service.js';
import * as store from './store.js';
import type { Experiment, Task } from './schema.js';

const originalEnv = { ...process.env };
beforeEach(() => { process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test'; });
afterEach(() => { process.env = { ...originalEnv }; });

const migration = (name: string) => readFileSync(new URL(`../../prisma/d1-migrations/${name}`, import.meta.url), 'utf8');
const N = 6;
const REFUSED = 1;
const refusedScene = `frame-${REFUSED}-scene`;
const FILTER_400 = 'OpenRouter image error 400: {"error":{"message":"The response was filtered due to the prompt triggering our content management policy. synthetic"}}';
const video = () => ({ id: 'src', mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: Array.from({ length: N }, (_, i) => `w/src/slides/${i}.jpg`) }) }) as unknown as Video;
const contract = {
  droppedSourceDefaults: [], droppedLocks: [], subject: 'objects', identity: 'invented-consistent', identitySheet: 'a woman, cartoon', medium: 'cartoon',
  keepSourceImage: false, borrowSourceLook: true, arcAxis: '',
  sourceFrameLevels: Array.from({ length: N }, (_, index) => ({ index, level: 'none', showsPerson: true })),
  slides: Array.from({ length: N }, (_, i) => ({ overlayText: i === 0 ? 'Hook A' : `copy ${i}`, arcLevel: 'none', scene: `frame-${i}-scene`, composition: 'centred', visibleChange: '' })),
  variantB: { variable: 'hook', value: 'Hook B', slides: [] },
};

function world() {
  const db = new Database(':memory:');
  for (const m of ['0008_experiments.sql', '0016_experiment_ran_by.sql', '0017_experiment_webhook_outbox.sql', '0019_experiment_test_key.sql']) db.exec(migration(m));
  const run = async (statements: RawStatement[]) => statements.map(s => db.query(s.sql).all(...((s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as any[])));
  const calls = { images: [] as Array<{ prompt: string; referenceUrl?: string }>, qa: 0, composed: [] as Array<{ text: string; index: number }> };
  const files = new Map<string, Buffer>();
  const render: RenderDeps = {
    findSources: async () => [video()],
    generateImage: async o => {
      calls.images.push({ prompt: o.prompt, referenceUrl: o.referenceUrl });
      if (o.prompt.includes(refusedScene)) throw new Error(FILTER_400);
      return { buffer: Buffer.from(`img${calls.images.length}`), contentType: 'image/jpeg', costUsd: 0.01 };
    },
    upload: async ({ path, body }) => { files.set(path, body); },
    composeOverlay: async o => { calls.composed.push({ text: o.text, index: o.slideIndex }); return { buffer: Buffer.concat([o.buffer, Buffer.from(`+${o.text}`)]), contentType: 'image/jpeg', font: 'Inter Bold', fontSize: 10, lines: [o.text], skipped: [] }; },
    readReference: async ({ path }) => files.get(path) ?? Buffer.from(`src:${path}`),
    describeCandidates: async () => { throw new Error('describe is removed'); },
    classify: async () => { throw new Error('no judge'); },
    generateBriefCandidates: async () => { throw new Error('no brief candidates'); },
    jevScores: async () => ({}),
    generateContract: async () => contract,
    verifyDeck: async () => { calls.qa++; throw new Error('QA must not run on a deck with a failed slide'); },
  };
  // The ledger is not under test: charges are applied to the row, and the real store persists it.
  const deps: EngineDeps = {
    load: () => store.load('w', 'e', run),
    save: async (e, charge = 0, _ref, refunds = []) => {
      const copy = { ...e, creditsCharged: e.creditsCharged + charge - refunds.reduce((n, r) => n + r.amount, 0) };
      const ok = await store.save(copy, 0, undefined, [], run);
      if (ok) Object.assign(e, copy);
      return ok;
    },
    prepare: (e, t) => prepare(e, t, render), now: () => 1000,
  };
  const api = {
    calls, files, deps, run,
    load: () => store.load('w', 'e', run),
    async update(fn: (e: Experiment) => void) { const e = await store.load('w', 'e', run); fn(e); if (!await store.save(e, 0, undefined, [], run)) throw new Error('cas'); return store.load('w', 'e', run); },
    async drain(max = 120) {
      for (let i = 0; i < max; i++) {
        await step('w', 'e', deps);
        if (!['planning', 'generating'].includes((await store.load('w', 'e', run)).status)) return;
      }
      throw new Error('did not settle');
    },
  };
  return api;
}

async function refusedBaseline() {
  const w = world();
  const now = new Date(0).toISOString();
  await store.create({
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: now, updatedAt: now, pipeline: 'contract', generationBasis: 'source-referenced',
    instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: 'Keep the pictures, change only the hook', lockedConstraints: [], sourceDefaults: [], variables: ['hook'], mode: 'controlled', overlayMode: 'script' },
    variantCount: 2, slideCount: N, maxCredits: 1000, creditsCharged: 0, report: null, error: null, assetPolicy: 'retained', commands: {}, allowPartial: false, createFingerprint: 'x',
    inputs: [{ videoId: 'src', status: 'ready', analysisId: 'an', jobId: null, error: null, coverage: { basis: 'slideshow+caption', observed: N, total: N, complete: true }, evidence: [{ location: 'slide:0', observation: 'a photo' }], copy: [] }],
    variants: [], tasks: [{ id: 'b', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment, 'k', w.run);
  await w.drain();
  await w.update(e => {
    for (const v of e.variants) {
      v.frozenBrief = structuredClone(v.brief); v.status = 'generating';
      v.slides = v.brief.slides.map((s, index) => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: s.overlayText ?? '' }));
      e.tasks.push(...generationTasks(v));
    }
    e.status = 'generating';
  });
  await w.drain();
  // Baseline slide 2 had already landed when slide 1 was refused, as in production; slides 3-5 were still queued. Stepping it here
  // would also fail the alternate's copy of slide 1 before the retry, which production's stopped run had not yet done.
  await w.update(e => {
    const t = e.tasks.find(x => x.kind === 'slide' && x.target === e.variants[0]!.id && x.index === 2)!;
    t.status = 'done'; t.attempts = 1;
    const path = `w/e/${e.variants[0]!.id}/2.jpg`;
    w.files.set(path, Buffer.from('synthetic-slide-2'));
    Object.assign(e.variants[0]!.slides[2]!, { status: 'done', path, url: `https://assets.example.test/${path}` });
    e.status = 'failed'; e.variants[0]!.status = 'failed';
  });
  return w;
}
const retry = (taskIds: string[]) => ({ workspaceId: 'w', idempotencyKey: 'retry-key', taskIds });
const allPending = (e: Experiment) => e.tasks.filter(t => t.status === 'pending').map(t => t.id);
const slideTask = (e: Experiment, variant: number, index: number) => e.tasks.find(t => t.kind === 'slide' && t.target === e.variants[variant]!.id && t.index === index)!;
const qaTask = (e: Experiment, variant: number) => e.tasks.find(t => t.kind === 'qa' && t.target === e.variants[variant]!.id)!;

describe('SLA-818: retrying everything pending after a baseline slide was refused', () => {
  test('the state before the retry is the production one', async () => {
    const w = await refusedBaseline();
    const e = await w.load();
    const [base, alt] = e.variants;
    expect(e.status).toBe('failed');
    expect(base!.slides.map(s => s.status)).toEqual(['done', 'failed', 'done', 'pending', 'pending', 'pending']);
    expect(slideTask(e, 0, REFUSED)).toMatchObject({ status: 'failed', attempts: 1, diagnostic: { kind: 'content_filter', invocations: 2, plainPromptRetry: true, overlayMode: 'script' } });
    expect(alt!.slides.every(s => s.status === 'pending')).toBe(true);
    expect(e.tasks.filter(t => t.status === 'pending').map(t => t.kind).sort()).toEqual(['qa', 'qa', ...Array(9).fill('slide')]);
    expect(w.calls.images.filter(c => c.prompt.includes(refusedScene))).toHaveLength(2);
  });

  test('the alternate hook finishes from the retained base, the dependent slide fails closed, and nothing replays the refusal', async () => {
    const w = await refusedBaseline();
    const before = await w.load();
    const refusedBefore = structuredClone(slideTask(before, 0, REFUSED));
    const imagesBefore = w.calls.images.length;
    const pending = before.tasks.filter(t => t.status === 'pending').map(t => t.id);
    expect(pending).toHaveLength(11);

    const reopened = await w.update(e => retryJobs(e, retry(pending)));
    expect(reopened.status).toBe('generating');
    expect(reopened.variants.map(v => v.status)).toEqual(['generating', 'generating']);

    await step('w', 'e', w.deps);
    const firstStep = await w.load();
    expect(slideTask(firstStep, 1, REFUSED)).toMatchObject({ status: 'failed', attempts: 0, charged: 0 });
    expect(slideTask(firstStep, 1, REFUSED).error).toStartWith('baseline_slide_unavailable');
    expect(firstStep.variants[1]!.slides[REFUSED]).toMatchObject({ status: 'failed' });

    await w.drain();
    const e = await w.load();
    const [base, alt] = e.variants;

    // The refused request was never sent again, by the baseline job or through the alternate's copy of it.
    expect(w.calls.images.filter(c => c.prompt.includes(refusedScene))).toHaveLength(2);
    expect(slideTask(e, 0, REFUSED)).toMatchObject({ status: 'failed', attempts: 1, charged: refusedBefore.charged, diagnostic: refusedBefore.diagnostic, error: refusedBefore.error });

    // Only the baseline's three queued slides called the model; the alternate used no provider call.
    expect(w.calls.images.slice(imagesBefore)).toHaveLength(3);
    expect(w.calls.images.slice(imagesBefore).every(c => !c.prompt.includes('Hook B'))).toBe(true);
    expect(alt!.slides.every(s => s.provider !== 'openrouter')).toBe(true);
    expect(slideTask(e, 1, 0)).toMatchObject({ status: 'done', attempts: 1, charged: 0 });
    expect(alt!.slides[0]).toMatchObject({ status: 'done', provider: 'script-overlay', overlay: { mode: 'script', lines: ['Hook B'] }, reference: { kind: 'baseline', videoId: base!.id, index: 0 } });
    expect(w.calls.composed).toContainEqual({ text: 'Hook B', index: 0 });
    expect(alt!.slides.map(s => s.status)).toEqual(['done', 'failed', 'done', 'done', 'done', 'done']);
    expect(alt!.slides.filter(s => s.status === 'done').slice(1).every(s => s.provider === 'reuse')).toBe(true);
    expect(base!.slides.map(s => s.status)).toEqual(['done', 'failed', 'done', 'done', 'done', 'done']);

    // Whole-run QA stays impossible while the failed slide is preserved: it is settled, never asked of the model.
    expect(w.calls.qa).toBe(0);
    expect(qaTask(e, 0)).toMatchObject({ status: 'failed', error: 'deck_incomplete' });
    expect(qaTask(e, 1)).toMatchObject({ status: 'failed', error: 'deck_incomplete' });

    // Both arms and the run settle visibly, and what is stored is what a later tick reads.
    expect(base!.status).toBe('failed');
    expect(base!.error).toContain('provider_content_filtered');
    expect(alt!.status).toBe('failed');
    expect(alt!.error).toStartWith('baseline_slide_unavailable');
    expect(e.status).toBe('failed');
    expect(e.error).toContain('provider_content_filtered');
    expect(e.tasks.some(t => t.status === 'pending' || t.status === 'running')).toBe(false);
    const view = store.serialize(e);
    expect(view.jobs.find(j => j.id === refusedBefore.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(view.variants[1]!.slides[0]).toMatchObject({ status: 'done' });
  });

  test('stepping the settled run again changes nothing', async () => {
    const w = await refusedBaseline();
    await w.update(e => retryJobs(e, retry(allPending(e))));
    await w.drain();
    const settled = await w.load();
    const images = w.calls.images.length;
    expect(await step('w', 'e', w.deps)).toBe(false);
    const again = await w.load();
    expect(again.version).toBe(settled.version);
    expect(w.calls.images).toHaveLength(images);
  });
});

describe('SLA-818: a baseline that is still producing or awaiting QA keeps gating its copies', () => {
  async function planned() {
    const w = world();
    const now = new Date(0).toISOString();
    await store.create({
      id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: now, updatedAt: now, pipeline: 'contract', generationBasis: 'source-referenced',
      instructions: { goal: 'g', brand: '', audience: '', language: 'English', direction: 'd', lockedConstraints: [], sourceDefaults: [], variables: ['hook'], mode: 'controlled', overlayMode: 'script' },
      variantCount: 2, slideCount: N, maxCredits: 1000, creditsCharged: 0, report: null, error: null, assetPolicy: 'retained', commands: {}, allowPartial: false, createFingerprint: 'x',
      inputs: [{ videoId: 'src', status: 'ready', analysisId: 'an', jobId: null, error: null, coverage: { basis: 'slideshow+caption', observed: N, total: N, complete: true }, evidence: [{ location: 'slide:0', observation: 'a photo' }], copy: [] }],
      variants: [], tasks: [{ id: 'b', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
    } as unknown as Experiment, 'k', w.run);
    await w.drain();
    return w.update(e => {
      for (const v of e.variants) {
        v.frozenBrief = structuredClone(v.brief); v.status = 'generating';
        v.slides = v.brief.slides.map((s, index) => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: s.overlayText ?? '' }));
        e.tasks.push(...generationTasks(v));
      }
      e.status = 'generating';
    });
  }
  const finish = (e: Experiment, variant: number, index: number) => {
    const t = slideTask(e, variant, index);
    t.status = 'done'; t.attempts = 1;
    Object.assign(e.variants[variant]!.slides[index]!, { status: 'done', path: `p/${variant}/${index}.jpg`, url: `https://assets.example.test/p/${variant}/${index}.jpg` });
  };
  const eligible = (e: Experiment, variant: number, index: number) => contractEligible(e, slideTask(e, variant, index));

  test('while a baseline slide is queued, its copy waits and so does every other copy (QA may still re-render the deck)', async () => {
    const e = await planned();
    for (const i of [0, 1, 2]) finish(e, 0, i);
    expect(eligible(e, 1, 0)).toBe(false);
    expect(eligible(e, 1, 1)).toBe(false);
    expect(eligible(e, 1, 4)).toBe(false);
  });

  test('with every baseline slide done and its QA still pending, copies keep waiting for the verdict', async () => {
    const e = await planned();
    for (let i = 0; i < N; i++) finish(e, 0, i);
    expect(qaTask(e, 0).status).toBe('pending');
    expect(eligible(e, 1, 0)).toBe(false);
    expect(eligible(e, 1, 3)).toBe(false);
  });

  test('once the baseline is judged, its copies are released', async () => {
    const e = await planned();
    for (let i = 0; i < N; i++) finish(e, 0, i);
    qaTask(e, 0).status = 'done';
    e.variants[0]!.status = 'done';
    expect(eligible(e, 1, 0)).toBe(true);
    finish(e, 1, 0);
    expect(eligible(e, 1, 3)).toBe(true);
  });

  test('a refused baseline slide releases the finished copies only: queued baseline slides and the refused one stay unavailable', async () => {
    const e = await planned();
    for (const i of [0, 2]) finish(e, 0, i);
    const refused = slideTask(e, 0, REFUSED);
    refused.status = 'failed'; refused.attempts = 1;
    e.variants[0]!.slides[REFUSED]!.status = 'failed';
    expect(eligible(e, 1, 0)).toBe(true);
    finish(e, 1, 0);
    expect(eligible(e, 1, 2)).toBe(true);
    expect(eligible(e, 1, REFUSED)).toBe(false);
    expect(eligible(e, 1, 3)).toBe(false);
  });

  test('the baseline is not settled while its own slides are still queued', async () => {
    const w = await refusedBaseline();
    await w.update(e => retryJobs(e, retry(allPending(e))));
    await step('w', 'e', w.deps);
    const e = await w.load();
    expect(e.variants[0]!.status).toBe('generating');
    expect(e.status).toBe('generating');
    expect(e.tasks.filter((t: Task) => t.kind === 'slide' && t.target === e.variants[0]!.id && t.status === 'pending').length).toBeGreaterThan(0);
  });
});
