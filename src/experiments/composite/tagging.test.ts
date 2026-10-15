import { describe, expect, test } from 'bun:test';
import { calibrateThresholds, parseLandmarkReply, relabelLibrary, tagFace, LANDMARK_SYSTEM_PROMPT } from './tagging.js';
import { DEFAULT_THRESHOLDS, verdictsFor } from './landmarks.js';
import { face } from './fixtures.js';
import type { FaceStore } from './face-store.js';

const reply = {
  view: 'profile',
  landmarks: {
    nasion: { x: 0.5, y: 0.2 }, chin: { x: 0.5, y: 0.6 }, earTragus: { x: 0.3, y: 0.3 }, gonion: { x: 0.3, y: 0.48 },
    bogus: { x: 0.1, y: 0.1 },
  },
};

describe('tagging (SLA-868)', () => {
  test('the prompt asks for geometry only and bars judgement of the face', () => {
    expect(LANDMARK_SYSTEM_PROMPT).toMatch(/geometry only/i);
    expect(LANDMARK_SYSTEM_PROMPT).toMatch(/never describe attractiveness/i);
    expect(LANDMARK_SYSTEM_PROMPT).not.toMatch(/\b(short|tall|good|ideal)\b ramus/i);
  });
  test('fractions are scaled to photo pixels and unknown landmark names are dropped', () => {
    const { landmarks, view } = parseLandmarkReply(reply, 1000, 2000);
    expect(view).toBe('profile');
    expect(landmarks.nasion).toEqual({ x: 500, y: 400 });
    expect(Object.keys(landmarks)).not.toContain('bogus');
  });
  test('a malformed reply is an error, not an empty tag', () => {
    expect(() => parseLandmarkReply('nope', 100, 100)).toThrow(/expected JSON/);
    expect(() => parseLandmarkReply(reply, 0, 100)).toThrow(/dimensions/);
  });
  test('the verdict comes from code over the measures, from one vision call', async () => {
    let calls = 0;
    const tags = await tagFace(async () => { calls++; return reply; }, new Uint8Array(1), { width: 1000, height: 2000 });
    expect(calls).toBe(1);
    expect(tags.measures.ramusLengthRatio).toBeCloseTo(0.45, 2);
    expect(tags.verdicts).toEqual(verdictsFor(tags.measures));
  });
});

describe('calibrateThresholds', () => {
  const rows = [
    ...[0.5, 0.52, 0.55].map(r => ({ measures: { ramusLengthRatio: r }, sourceVerdict: { ramus: 'pos' as const } })),
    ...[0.22, 0.25, 0.3].map(r => ({ measures: { ramusLengthRatio: r }, sourceVerdict: { ramus: 'neg' as const } })),
  ];
  test('fitted thresholds reproduce every labelled frame', () => {
    const { thresholds, report } = calibrateThresholds(rows);
    expect(report.find(r => r.feature === 'ramus')?.status).toBe('fitted');
    for (const r of rows) expect(verdictsFor(r.measures, thresholds).ramus).toBe(r.sourceVerdict.ramus);
  });
  test('overlapping or scarce labels keep the defaults and say why', () => {
    const overlap = calibrateThresholds([...rows, { measures: { ramusLengthRatio: 0.5 }, sourceVerdict: { ramus: 'neg' } }, { measures: { ramusLengthRatio: 0.3 }, sourceVerdict: { ramus: 'pos' } }]);
    expect(overlap.thresholds.ramus).toEqual(DEFAULT_THRESHOLDS.ramus);
    expect(overlap.report.find(r => r.feature === 'ramus')?.reason).toBe('labelled classes overlap');
    expect(calibrateThresholds([]).report.every(r => r.status === 'kept_default')).toBe(true);
  });
});

describe('relabelLibrary', () => {
  test('re-derives verdicts from stored measures without a model call', async () => {
    const f = face({ ramus: 0.45 });
    const saved: string[] = [];
    const store = { list: async () => [f], saveTags: async (id: string) => { saved.push(id); } } as unknown as FaceStore;
    expect(await relabelLibrary(store, 'ws', DEFAULT_THRESHOLDS)).toBe(0);
    const stricter = { ...DEFAULT_THRESHOLDS, ramus: { pos: { min: 0.6 }, neg: [{ max: 0.5 }] } };
    expect(await relabelLibrary(store, 'ws', stricter)).toBe(1);
    expect(saved).toEqual([f.id]);
  });
});
