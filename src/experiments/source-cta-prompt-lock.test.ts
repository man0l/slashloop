// SLA-497: `preserveSourceCtaSlide` must be a planning CONTRACT, not only a
// slide count.
//
// The defect this pins: SLA-476 made the opt-in keep the source deck's own
// closing app card in the persisted slide count, but every planning prompt kept
// telling the model "No CTA slide." — so the same instruction object that asked
// to keep the deck also ordered planning to drop its last beat. The count was
// honored (providers.ts:273) while the assembled report, baseline-storyboard and
// candidate prompts all contradicted it (the "No CTA slide." sentences sat on
// BOTH board-prompt branches and nowhere in the delta or report prompt was the
// preserved card named).
//
// These tests read the ACTUAL assembled prompts off the provider boundary with
// the network stubbed: `globalThis.fetch` is the only seam both `gemini()` and
// `callOpenRouterText()` use, so every assertion below is against the real
// request body that would have been billed, not against a copy of the template.
// No provider is reached and nothing is charged — the stubs return fixture JSON
// and record the URL they were asked for.
//
// The story-count store seam is injected (`storyCount`) so the suite never
// reaches a database, matching how source-cta-preservation.test.ts already
// isolates both count boundaries.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  SOURCE_CTA_PRESERVATION_LOCK,
  normalizeBriefCandidates,
  prepare,
  preservedFinalCopyBlock,
  renderDeps,
} from './providers.js';
import type { Experiment, Input, Task } from './schema.js';

const VIDEO_ID = '0669b3ad-f303-4b2b-b8a7-e142fb5692aa';
/** The live Clear Food deck's slide-3 overlay, exactly as recorded by analysis. */
const APP_CARD = 'Clear Food Download Clear Food Mixed Fruits 96 Good Healthier alternatives Your goals Clear skin 98 Body fat 95 Muscle 90 Health 98';
const DECK_OVERLAYS = ['average american boy', 'average american man', 'average european', APP_CARD];

const readyInput = (): Input => ({
  videoId: VIDEO_ID, status: 'ready', analysisId: 'e7307610', jobId: null, error: null,
  coverage: { basis: 'slideshow+caption', observed: 4, total: 4, complete: true },
  evidence: DECK_OVERLAYS.map((text, i) => ({
    location: `slide:${i}`,
    observation: `Slide ${i} of the source deck — on-image text: ${JSON.stringify(text)}`,
  })),
  copy: DECK_OVERLAYS.map((text, i) => ({ slideIndex: i, state: 'observed_text' as const, text })),
});

/**
 * The live draft under SLA-480/SLA-497: 4 slides, 2 variants, character-only
 * controlled, `preserveSourceCtaSlide: true`. `flag` is what each test varies.
 */
function draft(flag?: boolean): Experiment {
  return {
    id: 'aef259f8-308b-481f-ae05-83a72615faf7', workspaceId: 'd4bc6a00-695f-4366-8ac4-a4aa74092912',
    status: 'generating', generationBasis: 'source-referenced', styleFormula: { medium: 'photograph', density: 'rich' },
    variantCount: 2, slideCount: 4, maxCredits: 920, creditsCharged: 0,
    inputs: [readyInput()], variants: [], report: null, jobs: [], tasks: [],
    providerBudget: { maxRequests: 22, requestsStarted: 0, exactUsdCap: false },
    instructions: {
      goal: 'Test whether an average American boy outperforms the food outlier as the subject',
      brand: '', audience: '', language: 'English',
      direction: 'Replace the subject with an average American boy, consistent identity across slides.',
      lockedConstraints: [
        'Preserve the source food, framing, pose and styling exactly',
        'Preserve the exact on-image overlay text on every slide',
        'Preserve slide order and the full slide count including the final Clear Food app card',
        'No new product claims',
      ],
      variables: ['character'], mode: 'controlled',
      ...(flag === undefined ? {} : { preserveSourceCtaSlide: flag }),
    },
  } as unknown as Experiment;
}

/** The storyboard the fixture provider returns for the preserved deck. */
const boardFixture = {
  baseline: {
    title: 'Average American Boy', hypothesis: 'a boy subject clears more plates',
    concept: 'average american boy clears the plate', hook: 'average american boy',
    character: 'average american boy', visualStyle: 'photograph', caption: '',
    slides: DECK_OVERLAYS.map((text, i) => ({
      role: i === 3 ? 'cta' : i === 0 ? 'hook' : 'body',
      scene: `Source slide ${i} re-rendered with the same composition, food, framing and styling.`,
      overlayText: text,
    })),
  },
};
const deltasFixture = {
  candidates: [
    { title: 'Average American Man', hypothesis: 'a man subject clears more plates', mechanism: 'identity',
      changedVariables: [{ name: 'character', value: 'average american man' }] },
    { title: 'Average European', hypothesis: 'a european subject clears more plates', mechanism: 'named enemy',
      changedVariables: [{ name: 'character', value: 'average european' }] },
  ],
};

interface Captured { url: string; body: any }
let captured: Captured[] = [];
let realFetch: typeof globalThis.fetch;
const requestsTo = (needle: string) => captured.filter(c => c.url.includes(needle));
/** Every user prompt the fixture provider was actually asked to send. */
const openRouterPrompts = () => requestsTo('openrouter').flatMap(c => (c.body.messages ?? [])
  .filter((m: any) => m.role === 'user').map((m: any) => String(m.content)));
const geminiPrompts = () => requestsTo('generativelanguage').flatMap(c => [
  String(c.body.system_instruction?.parts?.[0]?.text ?? ''),
  String(c.body.contents?.[0]?.parts?.find((p: any) => p.text)?.text ?? ''),
].join('\n'));

beforeEach(() => {
  captured = [];
  process.env.OPENROUTER_API_KEY = 'sla-497-offline';
  process.env.GEMINI_API_KEY = 'sla-497-offline';
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    captured.push({ url, body });
    // The board call asks for the storyboard schema; the delta call for deltas.
    const wantsBoard = body?.response_format?.json_schema?.name === 'brief_board';
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(wantsBoard ? boardFixture : deltasFixture) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs the real planning call; the count seam keeps it off the database. */
function planBriefs(e: Experiment) {
  return renderDeps.generateBriefCandidates!(e, ' Visual formula: photograph medium.', async () => e.slideCount);
}

test('no provider request leaves the box: every provider call is stubbed', async () => {
  await planBriefs(draft(true));
  expect(captured.length).toBeGreaterThan(0);
  // Nothing reached a real host: only the two provider hosts the prompts name.
  for (const c of captured) expect(c.url).toMatch(/openrouter\.ai|generativelanguage\.googleapis\.com/);
});

test('the preserved baseline prompt keeps the app card and drops the contradiction', async () => {
  await planBriefs(draft(true));
  const [board] = openRouterPrompts();
  expect(board).toBeTruthy();
  // THE DEFECT: the opt-in deck was still told to drop a CTA slide.
  expect(board).not.toContain('No CTA slide');
  // The deck contract replaces it, verbatim, not as a paraphrase.
  expect(board).toContain(SOURCE_CTA_PRESERVATION_LOCK);
  expect(board).toContain(JSON.stringify(APP_CARD));
  expect(board).toContain('PRESERVED FINAL APP CARD');
  expect(board).toContain('Slide 4 IS the source deck\'s own closing app card');
  // Full source length and source order are both stated, and the count matches it.
  expect(board).toContain('exactly 4 story slides');
  expect(board).toContain('The deck keeps its FULL source length and the EXACT source slide order');
  // No invented CTA / claims is a separate, explicit prohibition.
  expect(board).toContain('Never invent CTA copy');
  expect(board).toContain('never add one');
  // Every source slide is mapped, in source order, each owning its overlay.
  const mapped = [...board!.matchAll(/- storyboard slide (\d+) adapts carousel 1: slide (\d+): [^\n]*?"([^"]*)"/g)]
    .map(m => ({ storyboard: Number(m[1]), source: Number(m[2]), text: m[3] }));
  expect(mapped.map(m => [m.storyboard, m.source, m.text])).toEqual(
    DECK_OVERLAYS.map((text, i) => [i + 1, i, text]),
  );
});

test('the preserved candidate prompt pins the final overlay verbatim and forbids additions', async () => {
  await planBriefs(draft(true));
  const [, delta] = openRouterPrompts();
  expect(delta).toBeTruthy();
  expect(delta).not.toContain('No CTA slide');
  expect(delta).toContain(SOURCE_CTA_PRESERVATION_LOCK);
  expect(delta).toContain(JSON.stringify(APP_CARD));
  // The character-only candidate rides the baseline storyboard, so the prompt
  // must explicitly override the "retell the payoff" wording above it.
  expect(delta).toContain('This overrides the payoff-retell wording above');
  expect(delta).toContain('Copy it VERBATIM on every candidate');
  expect(delta).toContain('never retell it, never shorten it, never blank it');
  // The rest of the candidate contract is untouched: the character-only delta
  // still rides the approved baseline storyboard.
  expect(delta).toContain('BASELINE STORYBOARD (already approved');
  expect(delta).toContain('name must be one of: character');
  expect(delta).toContain('CASTING (applies to every "character" value)');
});

test('the preserved report prompt names the card and forbids proposing CTA copy', async () => {
  const e = draft(true);
  // A schema-valid report so `Report.parse` + `validateReport` complete and the
  // assertions below are about the prompt that was sent, not an early throw.
  globalThis.fetch = (async (input: any, init: any = {}) => {
    captured.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: 's',
        patterns: [{
          id: 'p1', name: 'n', description: 'd', sourceIds: [VIDEO_ID],
          confidence: 0.9, frequency: 1,
          evidence: [{ videoId: VIDEO_ID, location: 'slide:3', observation: readyInput().evidence[3]!.observation }],
        }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await (await prepare(e, { id: 't', kind: 'report' } as Task)).execute();
  const report = geminiPrompts();
  expect(report.join('\n')).toContain(APP_CARD);
  expect(report.join('\n')).toContain('IS part of the carousel under test and is PRESERVED');
  expect(report.join('\n')).toContain('Never report it as a slide to drop');
  expect(report.join('\n')).toContain('never propose new CTA copy');
  // The established report rules survive alongside the preservation rule.
  expect(report.join('\n')).toContain('frequency equals unique sourceIds count');
});

test('omitted and false keep the established CTA exclusion and shorter story count', async () => {
  for (const flag of [undefined, false]) {
    captured = [];
    const e = draft(flag);
    // The count boundary itself: 4 source slides, no opt-in -> 3 story slides.
    e.slideCount = 3;
    await planBriefs(e);
    const [board, delta] = openRouterPrompts();
    expect(board).toContain('No CTA slide. No candidates.');
    expect(board).not.toContain(SOURCE_CTA_PRESERVATION_LOCK);
    expect(board).not.toContain('PRESERVED FINAL APP CARD');
    expect(board).toContain('exactly 3 story slides');
    expect(delta).not.toContain(SOURCE_CTA_PRESERVATION_LOCK);
    // No preservation wording reaches the report for a non-opted-in record.
    expect(preservedFinalCopyBlock(e)).toBe('');
  }
});

test('brief.cta stays empty while the source slide overlay is kept verbatim', async () => {
  const e = draft(true);
  const { baseline, candidates } = await planBriefs(e);
  // brief.cta is the generated CTA FIELD; the preserved card is slide copy.
  expect(baseline.brief.cta).toBe('');
  for (const c of candidates) expect(c.brief.cta).toBe('');
  // Four slides in source order, final overlay exact, no truncation.
  for (const p of [baseline, ...candidates]) {
    expect(p.brief.slides).toHaveLength(4);
    expect(p.brief.slides.map(s => s.overlayText)).toEqual(DECK_OVERLAYS);
    expect(p.brief.slides[3]!.overlayText).toBe(APP_CARD);
  }
  // The character-only candidate differs on character alone.
  expect(candidates[0]!.changedVariables).toEqual([{ name: 'character', value: 'average american man' }]);
  expect(candidates[0]!.brief.character).toBe('average american man');
  expect(candidates[0]!.brief.slides).toEqual(baseline.brief.slides);
});

test('a truncated or rewritten final overlay is caught by the preserved contract', async () => {
  const e = draft(true);
  // Normalization still slices to the resolved count; the protection that matters
  // is that the preserved path never silently accepts a 3-slide deck or a lost
  // app card when the source deck has four.
  const truncated = normalizeBriefCandidates({ baseline: boardFixture.baseline, candidates: deltasFixture.candidates }, 3, e);
  expect(truncated.baseline.brief.slides).toHaveLength(3);
  expect(truncated.baseline.brief.slides.map(s => s.overlayText)).not.toContain(APP_CARD);
  // …and the prompt that produces it always named the exact app card, so the
  // only way to lose it is a provider that ignored an explicit instruction.
  expect(preservedFinalCopyBlock(e)).toContain(JSON.stringify(APP_CARD));
});

test('an unknown final extraction is preserved as unknown, never quoted as text', () => {
  const e = draft(true);
  (e.inputs[0]!.copy!)[3] = { slideIndex: 3, state: 'unknown', text: null };
  const block = preservedFinalCopyBlock(e);
  expect(block).toContain('overlay is UNKNOWN');
  expect(block).not.toContain(APP_CARD);
  expect(preservedFinalCopyBlock(draft(false))).toBe('');
});