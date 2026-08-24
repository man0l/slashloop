// Pure-helper tests for the hook-test service — no DB, no Gemini.
// The lifecycle itself is exercised through the tools; these pin the pieces
// that turn stored rows into user-facing output.

import { describe, expect, test } from 'bun:test';
import { buildStopRule, serializeTest, buildShotlistMarkdown } from './hook-tests.js';
import type { SerializedHookTest } from './hook-tests.js';

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
