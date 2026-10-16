import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_THRESHOLDS, calibrateMonotone, computeMeasures, featureFromText, parseOverlayVerdict, verdictFor, verdictsFor,
} from './landmarks.js';
import { profileLandmarks } from './fixtures.js';

describe('computeMeasures', () => {
  test('ramus ratio is gonion-to-ear over nasion-to-chin height', () => {
    expect(computeMeasures(profileLandmarks({ ramus: 0.5 })).ramusLengthRatio).toBeCloseTo(0.5, 3);
  });
  test('canthal tilt is positive when the outer corner sits higher', () => {
    expect(computeMeasures(profileLandmarks({ ramus: 0.4, tiltDeg: 6 })).canthalTiltDeg).toBeCloseTo(6, 1);
    expect(computeMeasures(profileLandmarks({ ramus: 0.4, tiltDeg: -3 })).canthalTiltDeg).toBeCloseTo(-3, 1);
  });
  test('chin projection is signed along the facing direction', () => {
    expect(computeMeasures(profileLandmarks({ ramus: 0.4, projection: 0.08 })).chinProjectionRatio).toBeCloseTo(0.08, 3);
    expect(computeMeasures(profileLandmarks({ ramus: 0.4, projection: -0.08 })).chinProjectionRatio).toBeCloseTo(-0.08, 3);
  });
  test('missing landmarks omit the measure instead of guessing', () => {
    const l = profileLandmarks({ ramus: 0.4 });
    delete l.gonion;
    const m = computeMeasures(l);
    expect(m.ramusLengthRatio).toBeUndefined();
    expect(m.gonialAngleDeg).toBeUndefined();
    expect(m.canthalTiltDeg).toBeDefined();
    expect(computeMeasures({})).toEqual({});
  });
});

describe('verdicts', () => {
  test('a borderline measure is unknown, never forced to a side', () => {
    expect(verdictFor('ramus', { ramusLengthRatio: 0.38 })).toBe('unknown');
    expect(verdictFor('ramus', { ramusLengthRatio: 0.5 })).toBe('pos');
    expect(verdictFor('ramus', { ramusLengthRatio: 0.3 })).toBe('neg');
    expect(verdictFor('ramus', {})).toBe('unknown');
  });
  test('gonial angle is good inside its band and bad on both sides of it', () => {
    expect(verdictFor('gonial_angle', { gonialAngleDeg: 118 })).toBe('pos');
    expect(verdictFor('gonial_angle', { gonialAngleDeg: 95 })).toBe('neg');
    expect(verdictFor('gonial_angle', { gonialAngleDeg: 150 })).toBe('neg');
  });
  test('verdictsFor covers every feature', () => {
    expect(Object.keys(verdictsFor({ ramusLengthRatio: 0.5 })).sort()).toEqual(['canthal_tilt', 'forward_growth', 'gonial_angle', 'ramus']);
  });
});

// Frames from the cfe8dd16 reference, as the source labelled them on screen
// ("tall ramus ✅" / "short ramus ❌"), with the ramus ratio measured on each frame.
const CFE8DD16_FRAMES = [
  { overlay: 'tall ramus ✅', ramus: 0.47 },
  { overlay: 'short ramus ❌', ramus: 0.29 },
  { overlay: 'tall ramus ✅', ramus: 0.44 },
  { overlay: 'short ramus ❌', ramus: 0.32 },
  { overlay: 'tall ramus ✅', ramus: 0.52 },
  { overlay: 'short ramus ❌', ramus: 0.26 },
];

describe('calibration against the cfe8dd16 labels', () => {
  const samples = CFE8DD16_FRAMES.map(f => {
    const parsed = parseOverlayVerdict(f.overlay)!;
    return { parsed, measures: computeMeasures(profileLandmarks({ ramus: f.ramus })) };
  });

  test('every overlay parses to the ramus feature and its verdict', () => {
    expect(samples.map(s => [s.parsed.feature, s.parsed.verdict])).toEqual(
      CFE8DD16_FRAMES.map(f => ['ramus', f.overlay.includes('✅') ? 'pos' : 'neg']),
    );
  });
  test('the default thresholds reproduce every source label', () => {
    for (const s of samples) expect(verdictFor('ramus', s.measures)).toBe(s.parsed.verdict);
  });
  test('a threshold fitted to the labels reproduces them too', () => {
    const fitted = calibrateMonotone(samples.map(s => ({ value: s.measures.ramusLengthRatio!, verdict: s.parsed.verdict })), 'higher_better');
    expect(fitted).not.toBeNull();
    const thresholds = { ...DEFAULT_THRESHOLDS, ramus: fitted! };
    for (const s of samples) expect(verdictFor('ramus', s.measures, thresholds)).toBe(s.parsed.verdict);
  });
  test('overlapping classes do not produce a threshold', () => {
    expect(calibrateMonotone([{ value: 0.4, verdict: 'pos' }, { value: 0.45, verdict: 'neg' }], 'higher_better')).toBeNull();
    expect(calibrateMonotone([{ value: 0.4, verdict: 'pos' }], 'higher_better')).toBeNull();
  });
});

describe('parseOverlayVerdict', () => {
  test('keeps the on-screen wording as the label', () => {
    expect(parseOverlayVerdict('short ramus ❌')).toEqual({ feature: 'ramus', verdict: 'neg', label: 'short ramus' });
  });
  test('rejects text with no verdict mark, both marks, or no feature', () => {
    expect(parseOverlayVerdict('short ramus')).toBeNull();
    expect(parseOverlayVerdict('ramus ✅❌')).toBeNull();
    expect(parseOverlayVerdict('nice hair ✅')).toBeNull();
  });
  test('featureFromText finds a feature in free text', () => {
    expect(featureFromText('do it on canthal tilt this time')).toBe('canthal_tilt');
    expect(featureFromText('make it funnier')).toBeNull();
  });
});
