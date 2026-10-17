import { describe, expect, test } from 'bun:test';
import { buildCompositeDeckForVideo, type BuildDeckDeps } from './build.js';
import { face } from './fixtures.js';
import type { FaceStore } from './face-store.js';
import { CompositeError } from './plan.js';
import { storySlideCount } from '../slide-count.js';

const shots = ['short ramus ❌', 'tall ramus ✅', 'short ramus ❌', 'tall ramus ✅', 'short ramus ❌', 'tall ramus ✅', 'tall ramus ✅']
  .map((t, i) => ({ timestampSec: i, description: 'face photo', onScreenText: t }));
const analysis = { shots: [...shots, { timestampSec: 7, description: 'app score card showing PSL rating', onScreenText: 'PSL 7.2/10' }], onScreenText: [] };

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const stubSlide = async () => ({ buffer: Buffer.from(jpeg), contentType: 'image/jpeg' as const, skipped: [] });

function harness(library = [
  ...Array.from({ length: 8 }, () => face({ ramus: 0.5 })),
  ...Array.from({ length: 8 }, () => face({ ramus: 0.28 })),
  ...Array.from({ length: 4 }, (_, i) => face({ ramus: 0.52, source: 'commons', personName: `Person ${i}`, licence: 'CC0' })),
]) {
  const persisted: Array<{ n: number; stamp: Record<string, unknown> }> = [];
  const requested: string[] = [];
  const rendered: string[] = [];
  const faces: FaceStore = { list: async () => library, upsert: async () => { throw new Error('unused'); }, saveTags: async () => { throw new Error('unused'); }, listCalibration: async () => [] };
  const deps: BuildDeckDeps = {
    loadVideo: async (_w, id) => ({ id }),
    latestAnalysisJson: async () => analysis,
    faces,
    getImage: async key => { requested.push(key); return jpeg; },
    renderFace: async (...a) => { rendered.push(a[1].badge); return stubSlide(); },
    renderCard: stubSlide,
    persist: async (_w, _v, slides, stamp) => { persisted.push({ n: slides.length, stamp }); return slides.map((_, i) => `ws/v1/recreate/${String(i).padStart(2, '0')}.jpg`); },
  };
  return { deps, persisted, requested, rendered, library };
}

describe('buildCompositeDeckForVideo (SLA-868)', () => {
  test('renders the deck in code, persists it with a composite stamp, makes no image-model call', async () => {
    const h = harness();
    const out = await buildCompositeDeckForVideo('ws', 'v1', {}, h.deps);
    expect(out.imageModelCalls).toBe(0);
    expect(out.keys).toHaveLength(out.plan.slides.length);
    expect(out.plan.slides.length).toBeGreaterThanOrEqual(7);
    expect(out.plan.slides.length).toBeLessThanOrEqual(8);
    expect(h.persisted[0]!.stamp.model).toBe('composite');
    expect((h.persisted[0]!.stamp.compositeDeck as { fingerprint: string }).fingerprint).toBe(out.fingerprint);
  });
  test('stamps one {index, faceId, badge, label} per face slide', async () => {
    const h = harness();
    const out = await buildCompositeDeckForVideo('ws', 'v1', {}, h.deps);
    const stamp = h.persisted[0]!.stamp.compositeDeck as { faceIds: string[]; slides: Array<{ index: number; faceId: string; badge: string; label: string }> };
    expect(stamp.slides).toHaveLength(out.keys.length - 1);
    expect(stamp.slides.map(s => s.faceId)).toEqual(stamp.faceIds);
    out.plan.slides.forEach((p, i) => { if (p.type === 'face') expect(stamp.slides[i]).toEqual({ index: i, faceId: p.faceId, badge: p.badge, label: p.label }); });
  });
  test('the stored deck is exactly what an experiment keeps of it, however long the source pattern', async () => {
    const h = harness();
    h.deps.latestAnalysisJson = async () => ({
      shots: Array.from({ length: 12 }, (_, i) => ({ timestampSec: i, description: 'face photo', onScreenText: i % 2 ? 'tall ramus ✅' : 'short ramus ❌' })), onScreenText: [],
    });
    const out = await buildCompositeDeckForVideo('ws', 'v1', {}, h.deps);
    expect(out.keys).toHaveLength(8);
    expect(storySlideCount(out.keys.length, false)).toBe(out.keys.length);
  });
  test('no named real person is drawn on a negative slide', async () => {
    const h = harness();
    const out = await buildCompositeDeckForVideo('ws', 'v1', {}, h.deps);
    const byId = new Map(h.library.map(f => [f.id, f]));
    const negFaces = out.plan.slides.filter(s => s.type === 'face' && s.badge === 'neg').map(s => byId.get((s as { faceId: string }).faceId)!);
    expect(negFaces.length).toBeGreaterThan(0);
    expect(negFaces.every(f => !f.personName)).toBe(true);
  });
  test('a different seed or feature gives a different deck from the same library', async () => {
    const h = harness();
    const a = await buildCompositeDeckForVideo('ws', 'v1', { seed: 'a' }, h.deps);
    const b = await buildCompositeDeckForVideo('ws', 'v1', { seed: 'b' }, h.deps);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  test('refuses a video that is not photo-annotation, and a missing face image', async () => {
    const h = harness();
    await expect(buildCompositeDeckForVideo('ws', 'v1', {}, { ...h.deps, latestAnalysisJson: async () => ({ shots: [], onScreenText: [] }) })).rejects.toThrow(CompositeError);
    await expect(buildCompositeDeckForVideo('ws', 'v1', {}, { ...h.deps, getImage: async () => null })).rejects.toMatchObject({ code: 'face_image_missing' });
  });
});
