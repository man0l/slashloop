import { describe, expect, test } from 'bun:test';
import { buildCompositePlan, compositeDeckEstimate, deckSize, detectAnnotationPattern, type AnnotationPattern } from './deck.js';
import { validateCompositePlan } from './plan.js';
import { face, profileLandmarks } from './fixtures.js';
import { hasExperimentSlides } from '../../lib/media.js';

const shot = (t: number, onScreenText: string | null, description = 'face photo') => ({
  timestampSec: t, description, onScreenText, shotType: 'closeup', cameraMovement: 'static', durationSec: 1,
});
const analysis = (texts: Array<string | null>, last?: { description: string; text: string }) => ({
  summary: 's', shots: [...texts.map((t, i) => shot(i, t)), ...(last ? [shot(texts.length, last.text, last.description)] : [])], onScreenText: [],
});

describe('detectAnnotationPattern', () => {
  test('reads feature and verdict from each shot overlay, in order', () => {
    const p = detectAnnotationPattern(analysis(['short ramus ❌', 'tall ramus ✅', 'short ramus ❌', 'tall ramus ✅']))!;
    expect(p.slots.map(s => [s.feature, s.badge])).toEqual([['ramus', 'neg'], ['ramus', 'pos'], ['ramus', 'neg'], ['ramus', 'pos']]);
    expect(p.scoreCard).toBe(false);
  });
  test('a closing rating shot marks a score card', () => {
    const p = detectAnnotationPattern(analysis(['short ramus ❌', 'tall ramus ✅', 'tall ramus ✅'], { description: 'app screen showing PSL score', text: 'PSL 7.2/10' }));
    expect(p?.scoreCard).toBe(true);
  });
  test('an ordinary slideshow is not claimed', () => {
    expect(detectAnnotationPattern(analysis(['hook', 'step one', 'step two', 'follow']))).toBeNull();
    expect(detectAnnotationPattern(analysis(['short ramus ❌', 'tall ramus ✅']))).toBeNull();
    expect(detectAnnotationPattern({ nonsense: true })).toBeNull();
  });
});

describe('buildCompositePlan', () => {
  const pattern: AnnotationPattern = {
    scoreCard: true,
    slots: ['neg', 'pos', 'neg', 'pos', 'neg', 'pos', 'pos'].map((badge, i) => ({ timestampSec: i, feature: 'ramus' as const, badge: badge as 'pos' | 'neg', label: badge === 'pos' ? 'tall ramus' : 'short ramus' })),
  };
  const library = [
    ...Array.from({ length: 8 }, () => face({ ramus: 0.5 })),
    ...Array.from({ length: 8 }, () => face({ ramus: 0.28 })),
      ];

  test('builds a 7-11 slide deck that passes validation, closing on the score card', () => {
    const { plan } = buildCompositePlan(pattern, library, { seed: 'a' });
    expect(plan.slides.length).toBeGreaterThanOrEqual(7);
    expect(plan.slides.length).toBeLessThanOrEqual(11);
    expect(plan.slides.at(-1)!.type).toBe('score_card');
    expect(validateCompositePlan(plan, new Map(library.map(f => [f.id, f])))).toEqual([]);
  });
  test('follows the source ratio and order, with its wording', () => {
    const { plan } = buildCompositePlan(pattern, library, { seed: 'a' });
    const faces = plan.slides.filter(s => s.type === 'face');
    expect(faces.map(s => s.badge)).toEqual(['neg', 'pos', 'neg', 'pos', 'neg', 'pos', 'pos']);
    expect(faces[0]!.label).toBe('short ramus');
  });
  test('order and seed are multiplication axes; same inputs rebuild the same deck', () => {
    const a = buildCompositePlan(pattern, library, { seed: 'a' });
    expect(buildCompositePlan(pattern, library, { seed: 'a' }).faceIds).toEqual(a.faceIds);
    expect(buildCompositePlan(pattern, library, { seed: 'b' }).faceIds).not.toEqual(a.faceIds);
    const flipped = buildCompositePlan(pattern, library, { seed: 'a', order: ['pos', 'pos', 'neg'] });
    expect(flipped.plan.slides.filter(s => s.type === 'face').map(s => s.badge).slice(0, 3)).toEqual(['pos', 'pos', 'neg']);
  });
  test('a different feature in direction swaps the feature on every slide', () => {
    const lib = Array.from({ length: 16 }, (_, i) => face({ landmarks: profileLandmarks({ ramus: 0.5, tiltDeg: i % 2 ? 7 : -3, projection: 0.06 }) }));
    const { plan, feature } = buildCompositePlan(pattern, lib, { seed: 'a', direction: 'go with canthal tilt' });
    expect(feature).toBe('canthal_tilt');
    expect(plan.slides.filter(s => s.type === 'face').every(s => s.feature === 'canthal_tilt')).toBe(true);
  });
  test('no named real person lands on a negative slide', () => {
    const named = Array.from({ length: 8 }, (_, i) => face({ ramus: 0.28, source: 'commons', personName: `Person ${i}`, licence: 'CC0' }));
    const lib = [...library.filter(f => f.verdicts.ramus !== 'neg'), ...named];
    expect(() => buildCompositePlan(pattern, lib, { seed: 'a' })).toThrow(/Not enough/);
    const withSynthetic = [...lib, ...Array.from({ length: 6 }, () => face({ ramus: 0.28 }))];
    const { plan, faceIds } = buildCompositePlan(pattern, withSynthetic, { seed: 'a' });
    const byId = new Map(withSynthetic.map(f => [f.id, f]));
    plan.slides.forEach((s, i) => { if (s.type === 'face' && s.badge === 'neg') expect(byId.get(faceIds[i]!)!.personName).toBeNull(); });
  });
  test('deck size stays inside 7..11', () => {
    expect(deckSize({ slots: pattern.slots.slice(0, 3), scoreCard: false })).toBe(7);
    expect(deckSize({ slots: Array.from({ length: 20 }, () => pattern.slots[0]!), scoreCard: true })).toBe(11);
  });
});

describe('cost', () => {
  test('a composite deck costs no render credits and makes no image-model call', () => {
    for (const n of [7, 9, 11]) expect(compositeDeckEstimate(n)).toEqual({ slides: n, renderCredits: 0, totalCredits: 0, imageModelCalls: 0 });
  });
});

describe('eligibility', () => {
  test('a stamped composite deck makes a video experiment-eligible', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `ws/vid/recreate/${String(i).padStart(2, '0')}.jpg`);
    expect(hasExperimentSlides(JSON.stringify({}))).toBe(false);
    expect(hasExperimentSlides(JSON.stringify({ recreationKeys: keys, compositeDeck: { feature: 'ramus' } }))).toBe(true);
  });
});
