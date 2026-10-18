import { describe, expect, test } from 'bun:test';
import { compositeDeckView, type DeckFaceRow } from './read.js';

const rows: DeckFaceRow[] = [
  { id: 'f1', source: 'synthetic', personName: null, licence: 'synthetic', attribution: null },
  { id: 'f2', source: 'commons', personName: 'Person Two', licence: 'CC BY 4.0', attribution: 'Photo: X' },
];
const lookup = async (_w: string, ids: string[]) => rows.filter(r => ids.includes(r.id));
const raw = (deck: object) => JSON.stringify({ recreationKeys: ['a', 'b', 'c'], compositeDeck: deck });

describe('compositeDeckView (SLA-911)', () => {
  test('joins each stamped slide to its library row', async () => {
    const v = await compositeDeckView('ws', raw({
      fingerprint: 'fp', feature: 'ramus', builtAt: 't', faceIds: ['f1', 'f2'],
      slides: [{ index: 0, faceId: 'f1', badge: 'neg', label: 'short ramus' }, { index: 1, faceId: 'f2', badge: 'pos', label: 'tall ramus' }],
    }), 3, lookup);
    expect(v).toMatchObject({ fingerprint: 'fp', feature: 'ramus', slideCount: 3, detailed: true });
    expect(v!.slides).toEqual([
      { index: 0, faceId: 'f1', badge: 'neg', label: 'short ramus', source: 'synthetic', personName: null, licence: 'synthetic', attribution: null },
      { index: 1, faceId: 'f2', badge: 'pos', label: 'tall ramus', source: 'commons', personName: 'Person Two', licence: 'CC BY 4.0', attribution: 'Photo: X' },
    ]);
  });
  test('a deck stamped before per-slide detail falls back to faceIds with badge and label unknown', async () => {
    const v = await compositeDeckView('ws', raw({ fingerprint: 'fp', feature: null, builtAt: 't', faceIds: ['f2', 'gone'] }), 3, lookup);
    expect(v!.detailed).toBe(false);
    expect(v!.slides[0]).toMatchObject({ index: 0, faceId: 'f2', badge: null, label: null, personName: 'Person Two' });
    expect(v!.slides[1]).toMatchObject({ index: 1, faceId: 'gone', source: null, missing: true });
  });
  test('a video without a composite stamp has no block and makes no lookup', async () => {
    const never = async () => { throw new Error('lookup'); };
    expect(await compositeDeckView('ws', JSON.stringify({ recreationKeys: ['a'] }), 1, never)).toBeNull();
    expect(await compositeDeckView('ws', null, 0, never)).toBeNull();
  });
});
