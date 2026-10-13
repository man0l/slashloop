// SLA-787: overlayMode "script" renders the slide text-free and draws the copy in code.
import { describe, expect, test } from 'bun:test';
import { prepare, SafeFailure, TerminalFailure, CONTENT_FILTER_PATTERN } from './providers.js';
import { slideFanout } from './schema.js';
import type { Experiment, SlideVerification, Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';
import { admission } from './test-admission.js';

const HOOK = 'Quietly hex the boss';
const instructions = { goal: 'Sell tea', brand: 'Tea', audience: 'Adults', language: 'English', direction: 'Calm', lockedConstraints: [], variables: ['hook' as const], mode: 'controlled' as const };
const brief = { concept: 'Tea routine', hook: HOOK, character: 'Adult', visualStyle: 'Warm', caption: 'Tea time', cta: 'Get the app today', lockedConstraints: [],
  slides: [
    { role: 'hook', scene: 'A steaming cup on a wooden table by a window', overlayText: HOOK },
    { role: 'body', scene: 'Hands holding the cup', overlayText: 'Breathe slowly' },
    { role: 'end', scene: 'Empty cup, calm morning', overlayText: '' },
  ] };
function fixture(overlayMode?: 'model' | 'script', extra: Record<string, unknown> = {}): Experiment {
  const v = { id: 'v1', revision: 1, status: 'draft', title: 'B', hypothesis: 'h', changedVariables: [], brief, frozenBrief: brief, slides: [] };
  return { id: 'e', workspaceId: 'w', status: 'generating', version: 1, createdAt: '', updatedAt: '', instructions: { ...instructions, ...(overlayMode ? { overlayMode } : {}), ...extra }, variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 5, report: { summary: 'S' }, inputs: [], variants: [v], error: null, generationBasis: 'text-directed', assetPolicy: 'retained', tasks: [{ id: 't0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 10 }], commands: {}, allowPartial: false, createFingerprint: 'x' } as unknown as Experiment;
}
const pass: SlideVerification = { verdict: 'pass', reasons: [], checks: [{ check: 'c', status: 'pass' }], contractHash: '', corrected: false, attempts: 1 };

function deps(overrides: Record<string, unknown> = {}) {
  const seen = { prompts: [] as string[], uploads: [] as Buffer[], composed: [] as Array<{ text: string; slideIndex: number; buffer: Buffer }>, contracts: [] as SlideContract[] };
  const base = {
    findSources: async () => [] as never[],
    generateImage: async (opts: { prompt: string }) => { seen.prompts.push(opts.prompt); return { buffer: Buffer.alloc(600, 7), contentType: 'image/jpeg', costUsd: 0.01 }; },
    upload: async (o: { body: Buffer }) => { seen.uploads.push(o.body); return { path: 'p' }; },
    describeCandidates: async () => [{ id: 'c0', description: 'cup on table', medium: 'photograph', textBlocks: 0, overdesigned: false }],
    classify: async () => ({ choice: 'c0', confidence: 0.5 }),
    generateBriefCandidates: async () => { throw new Error('not used'); },
    jevScores: async () => { throw new Error('not used'); },
    verifyStory: async (o: { contract: SlideContract }) => { seen.contracts.push(o.contract); return pass; },
    composeOverlay: async (o: { buffer: Buffer; text: string; slideIndex: number }) => { seen.composed.push(o); return { buffer: Buffer.alloc(700, 9), contentType: 'image/jpeg', font: 'Inter Bold', fontSize: 80, lines: [o.text], skipped: [] }; },
  };
  return { ...base, ...overrides, seen } as unknown as Parameters<typeof prepare>[2] & { seen: typeof seen };
}
async function run(e: Experiment, render: Parameters<typeof prepare>[2], index = 0) {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.R2_THUMB_PUBLIC_BASE = 'https://thumbs.test';
  const prepared = await prepare(e, { id: 't0', kind: 'slide', target: 'v1', index, attempts: 0, charged: 10 } as unknown as Task, render);
  return await prepared.execute(admission()) as any;
}

describe('overlayMode "script"', () => {
  test('the provider prompt carries no overlay copy and asks for a text-free render', async () => {
    const render = deps();
    await run(fixture('script'), render);
    expect(render.seen.prompts).toHaveLength(slideFanout());
    for (const prompt of render.seen.prompts) {
      expect(prompt).not.toContain(HOOK);
      expect(prompt).not.toContain('Breathe slowly');
      expect(prompt).not.toContain('Get the app today');
      expect(prompt).toContain('TEXT-FREE RENDER');
      expect(prompt).toContain('FINAL RULE: the image contains no added text at all.');
    }
  });

  test('QA judges the text-free picture, then the copy is composed onto the verified bytes and uploaded', async () => {
    const render = deps();
    const result = await run(fixture('script'), render);
    expect(render.seen.contracts[0]!.overlay).toMatchObject({ mode: 'clear', text: '' });
    expect(render.seen.composed).toHaveLength(1);
    expect(render.seen.composed[0]).toMatchObject({ text: HOOK, slideIndex: 0 });
    expect(render.seen.composed[0]!.buffer[0]).toBe(7);
    expect(render.seen.uploads[0]![0]).toBe(9);
    expect(result.overlay).toMatchObject({ mode: 'script', font: 'Inter Bold', fontSize: 80, lines: [HOOK] });
    expect(result.story.verdict).toBe('pass');
  });

  test('a later slide draws its own text; a blank slide composes nothing and ships the render untouched', async () => {
    const body = deps();
    await run(fixture('script'), body, 1);
    expect(body.seen.composed[0]).toMatchObject({ text: 'Breathe slowly', slideIndex: 1 });
    const blank = deps();
    const result = await run(fixture('script'), blank, 2);
    expect(blank.seen.composed).toHaveLength(0);
    expect(blank.seen.uploads[0]![0]).toBe(7);
    expect(result.overlay).toEqual({ mode: 'script', text: '' });
  });

  test('copy quoted in the scene, constraints or direction never reaches the provider', async () => {
    const e = fixture('script', { direction: `Show the words "${HOOK}" on screen`, lockedConstraints: [`Never change "${HOOK}"`] });
    const render = deps();
    await run(e, render);
    for (const prompt of render.seen.prompts) expect(prompt).not.toContain(HOOK);
  });

  test('a corrective wave is redacted too', async () => {
    let calls = 0;
    const render = deps({ verifyStory: async () => (++calls === 1
      ? { ...pass, verdict: 'fail', reasons: [`the caption "${HOOK}" is visible`], checks: [{ check: 'c', status: 'fail', reason: 'x' }] }
      : pass) });
    await run(fixture('script'), render);
    expect(render.seen.prompts.length).toBe(2 * slideFanout());
    expect(render.seen.prompts.at(-1)).toContain('CORRECTIVE QA FEEDBACK');
    for (const prompt of render.seen.prompts) expect(prompt).not.toContain(HOOK);
  });

  test('a compositor failure is terminal and uploads nothing', async () => {
    const render = deps({ composeOverlay: async () => { throw new Error('font missing'); } });
    const err = await run(fixture('script'), render).catch(e => e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as Error).message).toContain('overlay_compose_failed:font missing');
    expect(render.seen.uploads).toHaveLength(0);
  });

  test('a provider that cannot compose (no dependency) fails closed, never ships text-free', async () => {
    const render = deps({ composeOverlay: undefined });
    const err = await run(fixture('script'), render).catch(e => e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect(render.seen.uploads).toHaveLength(0);
  });
});

describe('default overlayMode "model"', () => {
  test.each([undefined, 'model' as const])('mode %p keeps the copy in the prompt and never composes', async mode => {
    const render = deps();
    const result = await run(fixture(mode), render);
    expect(render.seen.prompts[0]).toContain(HOOK);
    expect(render.seen.prompts[0]).not.toContain('TEXT-FREE RENDER');
    expect(render.seen.composed).toHaveLength(0);
    expect(render.seen.uploads[0]![0]).toBe(7);
    expect(result.overlay).toBeUndefined();
  });
});

describe('content-filter classification', () => {
  const filtered = 'OpenRouter image error 400: {"error":{"message":"The response was filtered due to the prompt triggering our content management policy. Please modify your prompt and retry."}}';

  test('matches provider filter wording and not ordinary failures', () => {
    expect(CONTENT_FILTER_PATTERN.test(filtered)).toBe(true);
    expect(CONTENT_FILTER_PATTERN.test('finish_reason: content_filter')).toBe(true);
    for (const benign of ['OpenRouter image error 429: rate limited', 'OpenRouter image error 500: upstream timeout', 'socket lost', 'insufficient credits']) {
      expect(CONTENT_FILTER_PATTERN.test(benign)).toBe(false);
    }
  });

  test('model mode: one wave, terminal cause that points at script mode', async () => {
    let renders = 0;
    const render = deps({ generateImage: async () => { renders++; throw new Error(filtered); } });
    const err = await run(fixture(), render).catch(e => e);
    expect(err).toBeInstanceOf(SafeFailure);
    expect((err as Error).message).toStartWith('provider_content_filtered');
    expect((err as Error).message).toContain('overlayMode "script"');
    expect(renders).toBe(slideFanout());
  });

  test('script mode: the refusal is reported without suggesting the mode already in use', async () => {
    const render = deps({ generateImage: async () => { throw new Error(filtered); } });
    const err = await run(fixture('script'), render).catch(e => e);
    expect((err as Error).message).toStartWith('provider_content_filtered');
    expect((err as Error).message).not.toContain('Re-create');
  });

  test('an unrecognised provider refusal keeps its own wording instead of a 60-char stub', async () => {
    const odd = 'OpenRouter image error 400: {"error":{"message":"Request rejected by upstream moderation: category self_harm_adjacent","code":400}}';
    const render = deps({ generateImage: async () => { throw new Error(odd); } });
    const err = await run(fixture(), render).catch(e => e);
    expect((err as Error).message).toStartWith('all_candidates_failed[400 Request rejected by upstream moderation: category self_harm_adjacent');
  });

  test('a throttle that happens to mention nothing about filters stays retryable', async () => {
    const render = deps({ generateImage: async () => { throw new Error('OpenRouter image error 429: slow down'); } });
    const err = await run(fixture(), render).catch(e => e);
    expect((err as Error).message).toStartWith('rate_limited_429');
  });
});
