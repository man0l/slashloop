import { expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { encodeExperiment } from './document-budget.js';
import { Instructions, validateVariants, type BriefData, type Experiment, type InstructionsData } from './schema.js';
import { analysisHasCtaSlide, overlayLooksLikeCta } from './slide-count.js';
import { createExperiment, type CreateExperimentDeps } from './service.js';
import { resolveStorySlideCount } from './providers.js';

/**
 * SLA-476 regression, at both boundaries that derive a slide count.
 *
 * The defect: a four-slide Clear Food source whose final beat is a call to
 * action resolved to three slides, because `analysisHasCtaSlide` subtracts the
 * closing slide and BOTH `createExperiment` (which persists the count) and
 * `resolveStorySlideCount` (which re-derives it during planning) call that
 * heuristic. Fixing only creation regresses at planning, which is what PR #142
 * did.
 *
 * The source deck's own CTA slide is a deliberate part of that deck, so keeping
 * it must be an explicit opt-in (`preserveSourceCtaSlide`), never prose the
 * model has to be talked out of. Everything else about the experiment — character
 * as the only varied dimension, overlay/style/setting/story/CTA locked to the
 * source — must come out identical.
 *
 * Both boundaries take their store access as an injected seam (see
 * `CreateExperimentDeps` and `StorySlideCountDeps`), so this file needs no
 * process-global module mock and cannot be reordered under another suite.
 */

const VIDEO_ID = 'clear-food-source';
const WORKSPACE_ID = 'w1';

/** Four slideshow source keys, exactly as `experimentSourceKeys` reads them. */
const clearFoodRawJson = JSON.stringify({ slideshowKeys: ['slide-0', 'slide-1', 'slide-2', 'slide-3'] });

/**
 * The recorded analysis of that deck: the last beat is `role: 'cta'` and its
 * overlay starts "Clear Food Download Clear Food". Both are pinned in the test
 * below so that a change to either signal alone cannot quietly pass this file.
 */
const clearFoodAnalysis = {
  shots: [
    { timestampSec: 0, description: 'Boy sits down with a full plate', onScreenText: 'Average American Boy Breakfast' },
    { timestampSec: 1, description: 'First bite', onScreenText: 'Protein first' },
    { timestampSec: 2, description: 'Plate is empty', onScreenText: 'Cleared the plate' },
    { timestampSec: 3, description: 'Empty plate with the app badge', onScreenText: 'Clear Food Download Clear Food' },
  ],
  keyMoments: [
    { role: 'hook', timestampSec: 0 },
    { role: 'body', timestampSec: 1 },
    { role: 'body', timestampSec: 2 },
    { role: 'cta', timestampSec: 3 },
  ],
};

test('the drop came from the final cta role, not from overlay prose', () => {
  expect(analysisHasCtaSlide(clearFoodAnalysis, 4)).toBe(true);
  // "Clear Food Download Clear Food" is NOT phrasing the CTA-text detector
  // matches, so a prose-level fix could not have changed this count at all.
  expect(overlayLooksLikeCta('Clear Food Download Clear Food')).toBe(false);
  expect(analysisHasCtaSlide({ ...clearFoodAnalysis, keyMoments: clearFoodAnalysis.keyMoments.slice(0, 3) }, 4)).toBe(false);
});

/** Character-only controlled test: the single dimension this experiment varies. */
function characterInstructions(preserveSourceCtaSlide?: boolean): InstructionsData {
  return Instructions.parse({
    goal: 'Find the character that clears the most plates',
    brand: 'Clear Food', audience: 'US college students', language: 'English',
    direction: 'Change only the visible person. Keep the source overlay copy, style, setting and story.',
    lockedConstraints: [], variables: ['character'], mode: 'controlled',
    ...(preserveSourceCtaSlide === undefined ? {} : { preserveSourceCtaSlide }),
  });
}

const sourceVideo = {
  id: VIDEO_ID, rawJson: clearFoodRawJson, durationSec: 30, mediaStatus: 'slideshow', thumbnailUrl: null,
  creatorHandle: '@ballymaybach', caption: 'prove me wrong', views: 8_200_000,
} as unknown as Video;

/**
 * The real creation path, against a store that keeps documents the way D1 and
 * Postgres do: the experiment is encoded and then read back, so what these
 * tests assert is the persisted document, not an in-memory object.
 */
const documents = new Map<string, string>();
let keyCounter = 0;
const createDeps: CreateExperimentDeps = {
  findSource: async () => sourceVideo,
  findLatestAnalysis: async () => ({ analysisJson: JSON.stringify(clearFoodAnalysis) }),
  // Input building (compatibleInput) is not what this regression covers; the
  // count is derived from the source deck and the stored analysis, both above.
  buildInput: async (video) => ({ videoId: video.id, status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [] }),
  persist: async (experiment, idempotencyKey) => {
    const prior = documents.get(idempotencyKey);
    if (prior) return JSON.parse(prior) as Experiment;
    const json = encodeExperiment(experiment);
    documents.set(idempotencyKey, json);
    return JSON.parse(json) as Experiment;
  },
};

/** The planning path's single store access, serving the same source and analysis. */
const storyCountDeps = {
  batch: async (statements: Array<{ sql: string }>) => statements.map(s => (
    s.sql.includes('FROM "Video"')
      ? [{ id: VIDEO_ID, rawJson: clearFoodRawJson, durationSec: 30, mediaStatus: 'slideshow', thumbnailUrl: null }]
      : [{ videoId: VIDEO_ID, analysisJson: JSON.stringify(clearFoodAnalysis) }]
  )),
};

async function draft(instructions: InstructionsData): Promise<Experiment> {
  keyCounter += 1;
  return createExperiment({
    workspaceId: WORKSPACE_ID, videoIds: [VIDEO_ID], instructions,
    variantCount: 3, slideCount: 5, maxCredits: 100, idempotencyKey: `clearfood-regression-${keyCounter}`,
  }, createDeps);
}

test('creation persists four slides when preservation is requested', async () => {
  const e = await draft(characterInstructions(true));
  expect(e.slideCount).toBe(4);
  // Persisted, not merely in memory: planning re-reads this flag off the record.
  expect(e.instructions.preserveSourceCtaSlide).toBe(true);
  expect(e.creditsCharged).toBe(0);
});

test('creation still subtracts the CTA slide by default', async () => {
  expect((await draft(characterInstructions())).slideCount).toBe(3);
  expect((await draft(characterInstructions(false))).slideCount).toBe(3);
});

test('planning resolves the preserved count, not a re-derived one', async () => {
  expect(await resolveStorySlideCount(await draft(characterInstructions(true)), storyCountDeps)).toBe(4);
  expect(await resolveStorySlideCount(await draft(characterInstructions(false)), storyCountDeps)).toBe(3);
});

test('a record stored before the flag resolves exactly as it did', async () => {
  const e = await draft(characterInstructions(true));
  const legacy: Experiment = { ...e, instructions: { ...e.instructions } };
  delete (legacy.instructions as Record<string, unknown>).preserveSourceCtaSlide;
  expect(await resolveStorySlideCount(legacy, storyCountDeps)).toBe(3);
});

test('the flag is typed, optional and boolean', () => {
  const base = { ...characterInstructions() } as Record<string, unknown>;
  delete base.preserveSourceCtaSlide;
  expect(Instructions.safeParse(base).success).toBe(true);
  expect(Instructions.safeParse({ ...base, preserveSourceCtaSlide: true }).success).toBe(true);
  expect(Instructions.safeParse({ ...base, preserveSourceCtaSlide: false }).success).toBe(true);
  expect(Instructions.safeParse({ ...base, preserveSourceCtaSlide: 'yes' }).success).toBe(false);
});

test('a character-only test differs only by the explicit structural option', async () => {
  const preserved = await draft(characterInstructions(true));
  const subtracted = await draft(characterInstructions(false));
  const { preserveSourceCtaSlide: _preserved, ...preservedRest } = preserved.instructions;
  const { preserveSourceCtaSlide: _subtracted, ...subtractedRest } = subtracted.instructions;
  // Overlay copy, style, setting, story and CTA are untouched by preservation:
  // no copy override, no supporting-overlay retell, same locked constraints.
  expect(preservedRest).toEqual(subtractedRest);
  expect(preserved.instructions.copyOverrides).toBeUndefined();
  expect(preserved.instructions.varySupportingOverlays).toBeUndefined();
  expect(preserved.instructions.variables).toEqual(['character']);
});

test('only character may vary on a preserved four-slide deck', async () => {
  const e = await draft(characterInstructions(true));
  const brief = (over: Partial<BriefData> = {}): BriefData => ({
    concept: 'Average American Boy Breakfast', hook: 'Average American Boy Breakfast',
    character: 'average american boy', visualStyle: 'photograph', caption: '', cta: 'Download Clear Food',
    lockedConstraints: [],
    slides: [
      { role: 'hook', scene: 'Boy sits down with a full plate', overlayText: 'Average American Boy Breakfast' },
      { role: 'body', scene: 'First bite', overlayText: 'Protein first' },
      { role: 'body', scene: 'Plate is empty', overlayText: 'Cleared the plate' },
      { role: 'cta', scene: 'Empty plate with the app badge', overlayText: 'Clear Food Download Clear Food' },
    ],
    ...over,
  });
  const baseline = { title: 'Baseline', hypothesis: 'h', changedVariables: [], brief: brief() };
  const cast = {
    title: 'Cast', hypothesis: 'h', changedVariables: [{ name: 'character' as const, value: 'muscle boy' }],
    brief: brief({ character: 'muscle boy' }),
  };
  // Four brief slides against a persisted count of four: the source CTA slide is
  // part of the deck, so the baseline itself validates at the preserved count.
  expect(() => validateVariants(e, [baseline, cast])).not.toThrow();
  for (const locked of [
    { name: 'cta' as const, value: 'Order Clear Food', over: { cta: 'Order Clear Food' } },
    { name: 'visualStyle' as const, value: 'cartoon', over: { visualStyle: 'cartoon' } },
  ]) {
    expect(() => validateVariants(e, [baseline, {
      title: locked.name, hypothesis: 'h', changedVariables: [locked], brief: brief(locked.over),
    }])).toThrow('unapproved_variable');
  }
});
