import { describe, expect, test } from 'bun:test';
import { CompositeOptions, compositeDeckOf, deckFingerprint } from './options.js';

describe('deckFingerprint (SLA-868)', () => {
  test('is stable, and subset order and unrelated wording do not change it', () => {
    const a = deckFingerprint('v1', { subset: ['b', 'a'], direction: 'make it about the jaw please' });
    expect(deckFingerprint('v1', { subset: ['a', 'b'], direction: 'jaw, thanks' })).toBe(a);
  });
  test('each multiplication axis changes the deck identity', () => {
    const base = deckFingerprint('v1', {});
    const variants = [
      { feature: 'ramus' as const }, { direction: 'canthal tilt' }, { subset: ['a'] }, { order: ['neg' as const, 'pos' as const] },
      { scoreCard: { score: 7.1 } }, { seed: 'x' },
    ].map(r => deckFingerprint('v1', r));
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1 - (variants[0] === variants[1] ? 1 : 0));
    expect(deckFingerprint('v2', {})).not.toBe(base);
  });
  test('an explicit feature wins over one named in direction', () => {
    expect(deckFingerprint('v1', { feature: 'ramus', direction: 'canthal tilt' })).toBe(deckFingerprint('v1', { feature: 'ramus' }));
  });
});

describe('compositeDeckOf', () => {
  test('reads the stamp, ignores absent or malformed raw json', () => {
    expect(compositeDeckOf(JSON.stringify({ compositeDeck: { fingerprint: 'f', faceIds: ['a'] } }))?.fingerprint).toBe('f');
    expect(compositeDeckOf(JSON.stringify({ recreationKeys: [] }))).toBeNull();
    expect(compositeDeckOf('{nope')).toBeNull();
    expect(compositeDeckOf(null)).toBeNull();
  });
});

describe('CompositeOptions', () => {
  test('rejects an unknown feature and an out-of-range score', () => {
    expect(CompositeOptions.safeParse({ feature: 'nose-bridge' }).success).toBe(false);
    expect(CompositeOptions.safeParse({ scoreCard: { score: 11 } }).success).toBe(false);
    expect(CompositeOptions.safeParse({ feature: 'ramus', order: ['neg', 'pos'] }).success).toBe(true);
  });
});
