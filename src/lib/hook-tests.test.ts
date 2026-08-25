// Pure-helper tests for the hook-test service — no DB, no Gemini.
// The lifecycle itself is exercised through the tools; these pin the pieces
// that turn stored rows into user-facing output.

import { describe, expect, test } from 'bun:test';
import { buildStopRule, serializeTest, buildShotlistMarkdown } from './hook-tests.js';
import { applyLockedValues, lockSection, HOOK_TEST_TYPES, HookTestDraftSchema, normalizeDraftShape } from '../analysis/hook-tests.js';
import type { HookTestDraft } from '../analysis/hook-tests.js';
import type { SerializedHookTest } from './hook-tests.js';

describe('HookTestDraftSchema', () => {
  const opening = (over: Record<string, string> = {}) => ({
    type: 'recognition',
    hookText: 'I rebuilt my pricing page live on day one.',
    firstFrame: 'desk, laptop open',
    mechanism: 'stakes + specificity',
    ...over,
  });
  const draft = (versions: unknown[]) => ({ insight: 'Proof beats promises.', sameIn: [], beats: [], versions });

  test('accepts the full one-per-type shape', () => {
    const four = ['recognition', 'specific_number', 'contrarian', 'demo_first'].map((type) => opening({ type }));
    expect(HookTestDraftSchema.safeParse(draft(four)).success).toBe(true);
  });

  test('drops an entry with no usable hook line instead of failing the whole draft', () => {
    // The original outage: one lazy element failed the ENTIRE versions array.
    const four = [opening(), opening(), opening(), { type: 'demo_first', firstFrame: 'app screen' }];
    const result = HookTestDraftSchema.safeParse(draft(four));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.versions).toHaveLength(3);
  });

  test('still demands an insight and at least two usable openings', () => {
    expect(HookTestDraftSchema.safeParse(draft([opening()])).success).toBe(false);
    expect(HookTestDraftSchema.safeParse({ insight: '', sameIn: [], beats: [], versions: [opening(), opening()] }).success).toBe(false);
  });
});

describe('normalizeDraftShape', () => {
  const good = {
    insight: 'i',
    sameIn: [],
    beats: [],
    versions: [{ type: 'recognition', hookText: 'h' }, { type: 'contrarian', hookText: 'g' }],
  };

  test('passes a canonical draft through untouched', () => {
    expect(normalizeDraftShape(good)).toEqual(good);
    expect(normalizeDraftShape('nope')).toBe('nope');
  });

  test('unwraps a draft nested under a wrapper key', () => {
    const wrapped = { hookTest: good, notes: 'the model was asked to output raw JSON' };
    const result = HookTestDraftSchema.safeParse(normalizeDraftShape(wrapped));
    expect(result.success).toBe(true);
  });

  test('maps a bare versions array onto the draft shape — only the missing insight may complain', () => {
    // An insight-less array must still FAIL (insight is mandatory), but the
    // failure should name insight alone — proof the versions were understood.
    const result = HookTestDraftSchema.safeParse(
      normalizeDraftShape([{ type: 'contrarian', hookText: 'a' }, { type: 'recognition', hookText: 'b' }]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues.every((i) => i.path.join('.') === 'insight')).toBe(true);
    }
  });

  test('rescues renamed insight keys', () => {
    const aliased = { why_it_worked: 'numbers convince', sameIn: [], beats: [], versions: [good.versions[0], good.versions[1]] };
    const result = HookTestDraftSchema.safeParse(normalizeDraftShape(aliased));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.insight).toBe('numbers convince');
  });
});

describe('lockSection', () => {
  test('renders every locked element as a hard constraint', () => {
    const s = lockSection({ insight: 'Numbers convince.', sameIn: ['face to camera'], beats: ['tension', 'payoff'] });
    expect(s).toContain('HARD CONSTRAINTS');
    expect(s).toContain('INSIGHT (locked): Numbers convince.');
    expect(s).toContain('CONSTANTS (locked): face to camera');
    expect(s).toContain('STORY SHAPE (locked): tension → payoff');
  });

  test('empty lock renders nothing — first-run generation stays unconstrained', () => {
    expect(lockSection(undefined)).toBe('');
    expect(lockSection({})).toBe('');
  });
});

describe('applyLockedValues', () => {
  const draft: HookTestDraft = {
    insight: 'model echo',
    sameIn: ['model chip'],
    beats: ['model beat'],
    versions: [
      { type: 'recognition', hookText: 'a', firstFrame: '', mechanism: '' },
      { type: 'contrarian', hookText: 'b', firstFrame: '', mechanism: '' },
      { type: 'recognition', hookText: 'dup', firstFrame: '', mechanism: '' },
    ],
  };

  test('unlocked drafts pass through with type de-dup and cap at four', () => {
    const out = applyLockedValues(draft);
    expect(out.insight).toBe('model echo');
    expect(out.versions.map((v) => v.type)).toEqual(['recognition', 'contrarian']);
  });

  test('locked drafts keep the stored strategy verbatim, not the model echo', () => {
    const out = applyLockedValues(draft, {
      insight: 'user-edited insight',
      sameIn: ['stored chip'],
      beats: ['stored beat'],
    });
    expect(out.insight).toBe('user-edited insight');
    expect(out.sameIn).toEqual(['stored chip']);
    expect(out.beats).toEqual(['stored beat']);
  });

  test('partial locks only override what is set', () => {
    const out = applyLockedValues(draft, { insight: 'only insight' });
    expect(out.insight).toBe('only insight');
    expect(out.sameIn).toBe(draft.sameIn);
  });

  test('the four opening types are the v1 vocabulary', () => {
    expect([...HOOK_TEST_TYPES]).toEqual(['recognition', 'specific_number', 'contrarian', 'demo_first']);
  });
});

describe('buildStopRule', () => {
  test('derives a half-the-original bar from the source video views', () => {
    const rule = buildStopRule(120_000);
    expect(rule).toContain('60,000');
    expect(rule).toContain('two days');
  });

  test('falls back to the own-median bar when the video has no views yet', () => {
    expect(buildStopRule(0)).toContain('your own median');
  });
});

describe('serializeTest', () => {
  const base = {
    id: 't1', videoId: 'v1', lever: 'hook', insight: 'why it worked',
    sameInJson: '["face to camera","same kitchen"]',
    beatsJson: '["tension","proof","payoff"]',
    stopRule: 'stop', status: 'picking', createdAt: new Date('2026-08-24T00:00:00Z'),
  };

  test('parses the JSON columns back into arrays and ISO dates', () => {
    const s = serializeTest(base, []);
    expect(s.sameIn).toEqual(['face to camera', 'same kitchen']);
    expect(s.beats).toEqual(['tension', 'proof', 'payoff']);
    expect(s.createdAt).toBe('2026-08-24T00:00:00.000Z');
  });

  test('a corrupt JSON column degrades to [] instead of throwing', () => {
    const s = serializeTest({ ...base, sameInJson: 'not json' }, []);
    expect(s.sameIn).toEqual([]);
  });

  test('versions come out with ISO dates and their payload intact', () => {
    const s = serializeTest(base, [{
      id: 'hv1', label: 'A', round: 2, hookText: '"Nobody talks about this"',
      firstFrame: null, hookType: 'contrarian', mechanism: null,
      status: 'picked', assetUrl: null, createdAt: new Date('2026-08-24T01:02:03Z'),
    }]);
    expect(s.versions[0]!.label).toBe('A');
    expect(s.versions[0]!.round).toBe(2);
    expect(s.versions[0]!.createdAt).toBe('2026-08-24T01:02:03.000Z');
  });
});

describe('buildShotlistMarkdown', () => {
  const makeTest = (over: Partial<SerializedHookTest> = {}): SerializedHookTest => ({
    id: 't1', videoId: 'v1', lever: 'hook', insight: 'Numbers do the convincing.',
    sameIn: ['face to camera'], beats: ['tension', 'payoff'],
    stopRule: 'kill what stalls', status: 'picking', createdAt: '2026-08-24T00:00:00.000Z',
    versions: [
      { id: 'hv1', label: 'A', round: 1, hookText: '"I tested 7 of them"', firstFrame: 'phone in hand',
        hookType: 'specific_number', mechanism: 'concrete figure', status: 'picked',
        assetUrl: null, createdAt: 'x' },
      { id: 'hv2', label: 'B', round: 1, hookText: '"Everyone is wrong about this"', firstFrame: null,
        hookType: 'contrarian', mechanism: null, status: 'proposed', assetUrl: null, createdAt: 'x' },
    ],
    ...over,
  });
  const ctx = { creatorHandle: 'someone', caption: 'the original', url: 'https://tiktok.com/x' };

  test('exports only picked versions when any exist', () => {
    const md = buildShotlistMarkdown(makeTest(), ctx);
    expect(md).toContain('## Version A — specific number');
    expect(md).toContain('"I tested 7 of them"');
    expect(md).not.toContain('Everyone is wrong');
  });

  test('falls back to all live proposals when nothing is picked', () => {
    const md = buildShotlistMarkdown(makeTest({
      versions: makeTest().versions.map(v => ({ ...v, status: 'proposed' })),
    }), ctx);
    expect(md).toContain('nothing picked yet');
    expect(md).toContain('Version A');
    expect(md).toContain('Version B');
  });

  test('carries the frozen frame: insight, same-in chips, story shape, stop rule', () => {
    const md = buildShotlistMarkdown(makeTest(), ctx);
    expect(md).toContain('**Insight:** Numbers do the convincing.');
    expect(md).toContain('**Same in every version:** face to camera');
    expect(md).toContain('**Story shape:** tension → payoff');
    expect(md).toContain('**Stop rule:** kill what stalls');
  });

  test('labels later rounds so re-roll history stays readable', () => {
    const md = buildShotlistMarkdown(makeTest({
      versions: [{ ...makeTest().versions[0]!, round: 3 }],
    }), ctx);
    expect(md).toContain('(round 3)');
  });
});
