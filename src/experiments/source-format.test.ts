import { describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { Instructions, type Experiment } from './schema.js';
import { createExperiment, dedupeSourcePosts, type CreateExperimentDeps } from './service.js';
import { labelPolicy, mentionedAttributes } from './render-prompt.js';
import {
  PRESETS, SOURCE_FORMATS, emitsPersonLocks, expandPreset, inferSharedFormat, inferSourceFormat, universalLocks, type SourceFormat,
} from './source-format.js';

const NON_PERSON: SourceFormat[] = ['statue-collage', 'sprite-vs-real', 'sketch'];

describe('presets', () => {
  test('every format expands to a schema-valid instruction set', () => {
    for (const f of SOURCE_FORMATS) {
      const x = expandPreset(f, {}, true);
      const parsed = Instructions.safeParse({ goal: 'g', brand: '', audience: '', language: 'English', ...x, sourceFormat: f });
      expect(parsed.success).toBe(true);
      expect(x.lockedConstraints.length).toBeLessThanOrEqual(20);
    }
  });

  test('every format carries the four universal locks', () => {
    for (const f of SOURCE_FORMATS) {
      const locks = expandPreset(f, {}, true).lockedConstraints;
      for (const u of universalLocks()) expect(locks).toContain(u);
    }
    const joined = universalLocks().join(' | ').toLowerCase();
    expect(joined).toContain('watermarks');
    expect(joined).toContain('competitor');
    expect(joined).toContain('cta');
    expect(joined).toContain('celebrities');
    expect(joined).toContain('adults only');
  });

  test('non-person formats never lock a person attribute, even when a human is observed', () => {
    for (const f of NON_PERSON) {
      const x = expandPreset(f, {}, true);
      for (const lock of [...x.lockedConstraints, x.direction]) expect(mentionedAttributes(lock)).toEqual([]);
      expect(emitsPersonLocks(f, true)).toBe(false);
    }
  });

  test('statue preset follows the spec and calls the statue a sculpture', () => {
    const x = expandPreset('statue-collage', {});
    expect(x.variables).toEqual(['hook', 'visualStyle']);
    expect(x.mode).toBe('controlled');
    expect(x.direction).toContain('The statue is a sculpture, not a person.');
    expect(x.lockedConstraints.join(' ')).not.toMatch(/hair|eyes|complexion|wardrobe|jewelry/i);
  });

  test('exploration formats default to concept variables in exploration mode', () => {
    for (const f of ['sprite-vs-real', 'sketch'] as const) {
      const x = expandPreset(f, {});
      expect(x.mode).toBe('exploration');
      expect(x.variables).toContain('concept');
    }
  });

  test('person locks: photo-person yes, annotated-face and portrait-collage keep framing only, ai-render needs an observed human', () => {
    const photo = expandPreset('photo-person', {}).sourceDefaults.join(' ');
    expect(photo).toMatch(/hair/);
    expect(photo).toMatch(/wardrobe/);
    expect(emitsPersonLocks('photo-person', false)).toBe(true);
    for (const f of ['annotated-face', 'portrait-collage'] as const) {
      expect(emitsPersonLocks(f, false)).toBe(true);
      expect(expandPreset(f, {}).sourceDefaults.join(' ')).not.toMatch(/\bhair\b|eye colour|complexion|jewelry/i);
    }
    expect(expandPreset('ai-render', {}, false).sourceDefaults.join(' ')).not.toContain('visible person');
    expect(expandPreset('ai-render', {}, true).sourceDefaults.join(' ')).toContain('visible person');
  });

  test('photo-person does not lock the face attributes the caller is casting', () => {
    const fixed = expandPreset('photo-person', {}).sourceDefaults.join(' ');
    const cast = expandPreset('photo-person', { variables: ['character'] }).sourceDefaults.join(' ');
    expect(fixed).toMatch(/hair/);
    expect(cast).not.toMatch(/\bhair\b|eye colour|facial hair|complexion/i);
  });

  test('caller values win; caller locks are added, never replacing the presets', () => {
    const x = expandPreset('statue-collage', {
      variables: ['caption'], mode: 'controlled', direction: 'my direction', lockedConstraints: ['Keep the red border', 'no real people, celebrities or public figures; only invented likenesses'],
    });
    expect(x.variables).toEqual(['caption']);
    expect(x.direction).toBe('my direction');
    expect(x.lockedConstraints).toContain('Keep the red border');
    expect(x.lockedConstraints.filter(l => l.toLowerCase().startsWith('no real people'))).toHaveLength(1);
    for (const u of universalLocks()) expect(x.lockedConstraints).toContain(u);
  });

  test('a caller-chosen controlled mode drops the preset\'s exploration-only variables', () => {
    const x = expandPreset('sketch', { mode: 'controlled' });
    expect(x.variables).toEqual(['hook']);
    expect(x.mode).toBe('controlled');
  });

  test('caller variables that need exploration switch the mode', () => {
    expect(expandPreset('statue-collage', { variables: ['concept'] }).mode).toBe('exploration');
  });

  test('no format keeps the caller\'s instructions untouched', () => {
    const x = expandPreset(null, { variables: ['hook'], lockedConstraints: ['a'] });
    expect(x).toEqual({ variables: ['hook'], mode: 'controlled', direction: '', lockedConstraints: ['a'], sourceDefaults: [] });
  });

  test('preset locks do not read as the strip-all-labels policy', () => {
    for (const f of SOURCE_FORMATS) {
      const policy = labelPolicy(expandPreset(f, {}, true).lockedConstraints);
      expect(policy.preserve).toEqual([]);
      expect(policy.remove).toEqual(labelPolicy([]).remove);
    }
  });

  test('preset table covers exactly the supported formats', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...SOURCE_FORMATS].sort());
  });
});

describe('inference', () => {
  const analysis = (descriptions: string[], extra: Record<string, unknown> = {}) => ({
    shots: descriptions.map((description, i) => ({ timestampSec: i, durationSec: 1, type: 'other', description, onScreenText: null })), ...extra,
  });

  test('statue overlay', () => {
    expect(inferSourceFormat({ analysis: analysis(['2x2 food photos with a grayscale classical statue overlay, back view']) })?.format).toBe('statue-collage');
  });
  test('pixel sprites', () => {
    expect(inferSourceFormat({ analysis: analysis(['Real burger beside a pixel sprite of the same burger']) })?.format).toBe('sprite-vs-real');
  });
  test('line drawing character', () => {
    expect(inferSourceFormat({ analysis: analysis(['Black-and-white line drawing Wojak next to three food photos']) })?.format).toBe('sketch');
  });
  test('marker annotated faces', () => {
    expect(inferSourceFormat({ analysis: analysis(['Profile face with red line on the jaw: short ramus']) })?.format).toBe('annotated-face');
  });
  test('portrait collage needs the collage cue as well as the portrait cue', () => {
    const a = (type: string) => ({ shots: [{ timestampSec: 0, durationSec: 1, type, description: 'Food photos and a portrait labelled average american boy', onScreenText: null }] });
    expect(inferSourceFormat({ analysis: a('split_screen') })?.format).toBe('portrait-collage');
    expect(inferSourceFormat({ analysis: a('other') })).toBeNull();
  });
  test('talking-head majority wins over incidental statue talk', () => {
    const a = { shots: [
      { timestampSec: 0, durationSec: 1, type: 'talking_head', description: 'Man talks about the Statue of Liberty', onScreenText: null },
      { timestampSec: 1, durationSec: 1, type: 'talking_head', description: 'Man continues', onScreenText: null },
    ] };
    expect(inferSourceFormat({ analysis: a })).toEqual({ format: 'photo-person', observedHuman: true });
  });
  test('wardrobe in the recreation implies a photographed person', () => {
    const a = { shots: null, keyMoments: [{ role: 'hook', timestampSec: 0, subjectAction: 'Look at camera', wardrobeProps: 'black hoodie', setting: 'bedroom' }] };
    expect(inferSourceFormat({ analysis: a })?.format).toBe('photo-person');
  });
  test('no evidence, no preset', () => {
    expect(inferSourceFormat({ caption: 'prove me wrong' })).toBeNull();
    expect(inferSourceFormat({ analysis: null })).toBeNull();
    expect(inferSourceFormat({ analysis: 'garbage' })).toBeNull();
  });
  test('sources must agree, otherwise the plain defaults stand', () => {
    const statue = { analysis: analysis(['grayscale statue overlay']) };
    const sprite = { analysis: analysis(['pixel sprite pair']) };
    expect(inferSharedFormat([statue, statue])?.format).toBe('statue-collage');
    expect(inferSharedFormat([statue, sprite])).toBeNull();
    expect(inferSharedFormat([statue, {}])).toBeNull();
    expect(inferSharedFormat([])).toBeNull();
  });
});

// ---- createExperiment, against injected store access -------------------------------

const rawJson = JSON.stringify({ slideshowKeys: ['s0', 's1', 's2', 's3'] });
function videoRow(id: string, over: Record<string, unknown> = {}) {
  return { id, rawJson, durationSec: 30, mediaStatus: 'slideshow', thumbnailUrl: null, creatorHandle: '@creator', caption: 'c', views: 1000, platform: 'tiktok', externalId: `post-${id}`, ...over } as unknown as Video;
}
function depsFor(analysisByVideo: Record<string, unknown>, rows: Record<string, Video>, persisted: Experiment[] = []): CreateExperimentDeps {
  return {
    findSource: async (_w, id) => rows[id] ?? null,
    findLatestAnalysis: async id => analysisByVideo[id] ? { analysisJson: JSON.stringify(analysisByVideo[id]) } : null,
    buildInput: async v => ({ videoId: v.id, status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [] }),
    persist: async e => { persisted.push(e); return e; },
  };
}
const statueAnalysis = { shots: [{ timestampSec: 0, durationSec: 1, type: 'split_screen', description: '2x2 food photos with a grayscale classical statue overlay', onScreenText: null }] };
const request = (instructions: Record<string, unknown>, videoIds = ['v1']) => ({
  workspaceId: 'w1', videoIds, instructions: { goal: 'Test', brand: '', audience: '', language: 'English', ...instructions }, variantCount: 3, slideCount: 5, maxCredits: 400, idempotencyKey: 'key-12345678',
});

describe('createExperiment with a source format', () => {
  test('explicit sourceFormat fills variables, mode, direction and locks from just a goal', async () => {
    const out: Experiment[] = [];
    await createExperiment(request({ sourceFormat: 'statue-collage' }), depsFor({}, { v1: videoRow('v1') }, out));
    const i = out[0]!.instructions;
    expect(i.sourceFormat).toBe('statue-collage');
    expect(i.variables).toEqual(['hook', 'visualStyle']);
    expect(i.mode).toBe('controlled');
    expect(i.direction).toContain('sculpture');
    expect(i.lockedConstraints).toEqual(expandPreset('statue-collage', {}).lockedConstraints);
  });

  test('format is inferred from the analysis when unset, and stored resolved', async () => {
    const out: Experiment[] = [];
    await createExperiment(request({}), depsFor({ v1: statueAnalysis }, { v1: videoRow('v1') }, out));
    expect(out[0]!.instructions.sourceFormat).toBe('statue-collage');
    expect(out[0]!.instructions.sourceDefaults).toContain('The statue stays a grayscale marble or plaster sculpture with no real face');
    expect(out[0]!.instructions.lockedConstraints).not.toContain('The statue stays a grayscale marble or plaster sculpture with no real face');
  });

  test('an explicit complete instruction set keeps the caller\'s values and gains the locks', async () => {
    const out: Experiment[] = [];
    await createExperiment(request({ variables: ['caption'], mode: 'controlled', direction: 'mine', lockedConstraints: ['Keep the border'] }), depsFor({ v1: statueAnalysis }, { v1: videoRow('v1') }, out));
    const i = out[0]!.instructions;
    expect([i.variables, i.mode, i.direction]).toEqual([['caption'], 'controlled', 'mine']);
    expect(i.lockedConstraints).toContain('Keep the border');
    expect(i.lockedConstraints).toContain(universalLocks()[0]!);
  });

  test('no explicit format and nothing to infer keeps the legacy instructions exactly', async () => {
    const out: Experiment[] = [];
    await createExperiment(request({ variables: ['hook'], mode: 'controlled', direction: '', lockedConstraints: [] }), depsFor({}, { v1: videoRow('v1') }, out));
    const i = out[0]!.instructions;
    expect(i.sourceFormat).toBeUndefined();
    expect(i.lockedConstraints).toEqual([]);
    expect(i.mode).toBe('controlled');
  });

  test('no format and no variables is still a validation error', async () => {
    await expect(createExperiment(request({}), depsFor({}, { v1: videoRow('v1') }))).rejects.toThrow();
  });

  test('expandFormat:false (edit mode) never adds a preset, even for an inferable source', async () => {
    const out: Experiment[] = [];
    const body = request({ variables: ['character'], mode: 'controlled', direction: 'd', lockedConstraints: [] });
    await createExperiment(body, depsFor({ v1: statueAnalysis }, { v1: videoRow('v1') }, out), { expandFormat: false });
    expect(out[0]!.instructions.lockedConstraints).toEqual([]);
    expect(out[0]!.instructions.sourceFormat).toBeUndefined();
  });

  test('the idempotency fingerprint is taken from the request, not the inferred expansion', async () => {
    const a: Experiment[] = [];
    const b: Experiment[] = [];
    const body = request({ sourceFormat: 'sketch' });
    await createExperiment(body, depsFor({}, { v1: videoRow('v1') }, a));
    await createExperiment(body, depsFor({ v1: statueAnalysis }, { v1: videoRow('v1') }, b));
    expect(a[0]!.createFingerprint).toBe(b[0]!.createFingerprint);
  });

  test('two ids for one post in a single experiment are refused', async () => {
    const rows = { v1: videoRow('v1', { externalId: 'same' }), v2: videoRow('v2', { externalId: 'same' }) };
    await expect(createExperiment(request({ sourceFormat: 'sketch' }, ['v1', 'v2']), depsFor({}, rows))).rejects.toMatchObject({ code: 'duplicate_source_post' });
  });
});

describe('dedupeSourcePosts', () => {
  const rows = [
    { id: 'a1', platform: 'tiktok', externalId: 'p1', analyzed: false },
    { id: 'a2', platform: 'tiktok', externalId: 'p1', analyzed: true },
    { id: 'b1', platform: 'tiktok', externalId: 'p2', analyzed: false },
    { id: 'c1', platform: 'reels', externalId: 'p1', analyzed: false },
  ];
  const find = async (_w: string, ids: string[]) => rows.filter(r => ids.includes(r.id));

  test('one id per platform+externalId, preferring the analyzed one, in the caller\'s order', async () => {
    const out = await dedupeSourcePosts('w1', ['a1', 'b1', 'a2', 'c1'], find);
    expect(out.videoIds).toEqual(['b1', 'a2', 'c1']);
    expect(out.duplicates).toEqual([{ videoId: 'a1', duplicateOf: 'a2' }]);
  });

  test('without analysis the first listed id wins; unknown ids pass through', async () => {
    const out = await dedupeSourcePosts('w1', ['x9', 'b1', 'a1'], find);
    expect(out.videoIds).toEqual(['x9', 'b1', 'a1']);
    expect(out.duplicates).toEqual([]);
    const first = await dedupeSourcePosts('w1', ['a1', 'b1'], find);
    expect(first.videoIds).toEqual(['a1', 'b1']);
  });
});
