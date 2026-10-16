import { describe, expect, test } from 'bun:test';
import {
  CompositeError, CompositePlan, assertValidCompositePlan, attributionFor, faceSlide, requiresAttribution, selectFaces, validateCompositePlan,
  type CompositePlanT, type FaceRecord,
} from './plan.js';
import { face } from './fixtures.js';

const byId = (faces: FaceRecord[]) => new Map(faces.map(f => [f.id, f]));
const card = { type: 'score_card' as const, appName: 'PSL', name: 'You', score: 6 };
const planOf = (...slides: unknown[]): CompositePlanT => CompositePlan.parse({ renderKind: 'composite', slides: [...slides, card] });

describe('named people are positive-side only', () => {
  const celebrity = face({ id: 'celeb', source: 'commons', personName: 'Famous Person', licence: 'CC0', sourceRef: 'File:Famous.jpg', ramus: 0.3 });

  test('a named person with a neg badge is rejected at plan validation', () => {
    // Force the contradiction on purpose: the library says neg, the person is named.
    const rec = { ...celebrity, verdicts: { ramus: 'neg' as const } };
    const plan = planOf(faceSlide({ feature: 'ramus', badge: 'neg' }, rec));
    const issues = validateCompositePlan(plan, byId([rec]));
    expect(issues.map(i => i.code)).toContain('named_person_on_negative_side');
    expect(() => assertValidCompositePlan(plan, byId([rec]))).toThrow(CompositeError);
  });

  test('the same person is fine on the positive side', () => {
    const pos = face({ id: 'celeb2', source: 'commons', personName: 'Famous Person', licence: 'CC0', sourceRef: 'File:F.jpg', ramus: 0.5 });
    const plan = planOf(faceSlide({ feature: 'ramus', badge: 'pos' }, pos));
    expect(validateCompositePlan(plan, byId([pos]))).toEqual([]);
  });

  test('selectFaces never seats a named person on a neg slot even when no one else is left', () => {
    const rec = { ...celebrity, verdicts: { ramus: 'neg' as const } };
    expect(() => selectFaces([rec], [{ feature: 'ramus', badge: 'neg' }], { seed: 's' })).toThrow(/library_too_small|Not enough/);
  });

  test('an unnamed commons photo is still treated as a real person', () => {
    const rec = face({ source: 'commons', personName: null, licence: 'CC0', ramus: 0.3 });
    expect(() => selectFaces([rec], [{ feature: 'ramus', badge: 'neg' }], { seed: 's' })).toThrow(CompositeError);
  });
});

describe('plan rules', () => {
  test('a badge must agree with the face verdict the code computed', () => {
    const f = face({ ramus: 0.5 });
    const plan = planOf(faceSlide({ feature: 'ramus', badge: 'pos' }, f));
    (plan.slides[0] as { badge: string }).badge = 'neg';
    expect(validateCompositePlan(plan, byId([f])).map(i => i.code)).toContain('badge_contradicts_face_verdict');
  });
  test('a face appears once; the score card closes the deck', () => {
    const f = face({ ramus: 0.5 });
    const s = faceSlide({ feature: 'ramus', badge: 'pos' }, f);
    expect(validateCompositePlan(planOf(s, s), byId([f])).map(i => i.code)).toContain('face_reused');
    const early = CompositePlan.parse({ renderKind: 'composite', slides: [card, s] });
    expect(validateCompositePlan(early, byId([f])).map(i => i.code)).toContain('score_card_must_close');
  });
  test('an unknown face id is refused', () => {
    const f = face({ ramus: 0.5 });
    expect(validateCompositePlan(planOf(faceSlide({ feature: 'ramus', badge: 'pos' }, f)), new Map()).map(i => i.code)).toContain('face_not_found');
  });
  test('a deck holds at most 11 slides', () => {
    const faces = Array.from({ length: 11 }, () => face({ ramus: 0.5 }));
    const slides = faces.map(f => faceSlide({ feature: 'ramus', badge: 'pos' }, f));
    expect(CompositePlan.safeParse({ renderKind: 'composite', slides: [...slides, card] }).success).toBe(false);
  });
});

describe('licence attribution', () => {
  const commons = (licence: string) => face({ source: 'commons', personName: 'A Person', licence, attribution: 'Jane Photographer', sourceRef: 'File:A.jpg', ramus: 0.5 });

  test('a CC-BY row carries its credit line onto the slide', () => {
    const f = commons('CC BY-SA 4.0');
    expect(requiresAttribution(f.licence)).toBe(true);
    expect(attributionFor(f)).toBe('Jane Photographer / Wikimedia Commons / CC BY-SA 4.0');
    expect(faceSlide({ feature: 'ramus', badge: 'pos' }, f).attribution).toBe('Jane Photographer / Wikimedia Commons / CC BY-SA 4.0');
  });
  test('CC0, public domain, synthetic and gallery rows carry none', () => {
    for (const f of [commons('CC0'), commons('Public domain'), face({ ramus: 0.5 }), face({ source: 'gallery_frame', ramus: 0.5 })]) {
      expect(attributionFor(f)).toBeNull();
      expect(faceSlide({ feature: 'ramus', badge: 'pos' }, f).attribution).toBeUndefined();
    }
  });
  test('a CC-BY slide missing its credit fails validation', () => {
    const f = commons('CC BY 4.0');
    const plan = planOf(faceSlide({ feature: 'ramus', badge: 'pos' }, f));
    delete (plan.slides[0] as { attribution?: string }).attribution;
    expect(validateCompositePlan(plan, byId([f])).map(i => i.code)).toContain('attribution_required');
  });
});

describe('selectFaces', () => {
  test('is deterministic for a seed and varies across seeds', () => {
    const lib = Array.from({ length: 12 }, () => face({ ramus: 0.5 }));
    const slots = [{ feature: 'ramus' as const, badge: 'pos' as const }, { feature: 'ramus' as const, badge: 'pos' as const }];
    const a = selectFaces(lib, slots, { seed: 'one' }).map(p => p.face.id);
    expect(selectFaces(lib, slots, { seed: 'one' }).map(p => p.face.id)).toEqual(a);
    const decks = new Set(['two', 'three', 'four', 'five', 'six'].map(seed => selectFaces(lib, slots, { seed }).map(p => p.face.id).join()));
    expect(decks.size).toBeGreaterThan(1);
  });
  test('honours the subset and the slot verdict', () => {
    const pos = face({ ramus: 0.5 }), neg = face({ ramus: 0.28 });
    expect(selectFaces([pos, neg], [{ feature: 'ramus', badge: 'neg' }], { seed: 's' })[0]!.face.id).toBe(neg.id);
    expect(() => selectFaces([pos, neg], [{ feature: 'ramus', badge: 'neg' }], { seed: 's', subset: [pos.id] })).toThrow(/Not enough/);
  });
  test('skips faces without the landmarks the annotation needs', () => {
    const bare = face({ ramus: 0.5 });
    delete bare.landmarks.gonion;
    expect(() => selectFaces([bare], [{ feature: 'ramus', badge: 'pos' }], { seed: 's' })).toThrow(CompositeError);
  });
});
