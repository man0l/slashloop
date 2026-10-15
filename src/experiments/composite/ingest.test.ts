import { describe, expect, test } from 'bun:test';
import { ingestCommonsFile, ingestGalleryFrames, ingestImage, ingestSyntheticFaces, type IngestDeps } from './ingest.js';
import { fetchCommonsFile, normaliseLicence, type FetchLike } from './commons.js';
import { usableFaces, type FaceStore } from './face-store.js';
import { face } from './fixtures.js';
import { computeMeasures, verdictsFor } from './landmarks.js';
import type { FaceRecord } from './plan.js';

const reply = { view: 'profile', landmarks: { nasion: { x: 0.5, y: 0.2 }, chin: { x: 0.5, y: 0.6 }, earTragus: { x: 0.3, y: 0.3 }, gonion: { x: 0.3, y: 0.48 } } };

function harness(vision: IngestDeps['vision'] = async () => reply) {
  const rows: FaceRecord[] = [];
  const stored: string[] = [];
  const store: FaceStore = {
    list: async () => rows,
    upsert: async row => {
      const landmarks = row.landmarks ?? {};
      const measures = computeMeasures(landmarks);
      const f = face({ id: `f${rows.length}`, source: row.source, sourceRef: row.sourceRef, personName: row.personName ?? null, licence: row.licence ?? null, attribution: row.attribution ?? null, view: row.view, imageKey: row.imageKey, landmarks, measures, verdicts: verdictsFor(measures) });
      rows.push(f);
      return f;
    },
    saveTags: async () => {}, listCalibration: async () => [],
  };
  const deps: IngestDeps = { store, vision, putImage: async k => { stored.push(k); }, imageSize: async () => ({ width: 1000, height: 2000 }), newId: () => `img${stored.length}` };
  return { deps, rows, stored };
}

describe('ingestImage (SLA-868)', () => {
  test('tags, stores the image under the workspace and adds a row', async () => {
    const h = harness();
    const r = await ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'synthetic', sourceRef: 'a#0' });
    expect(r.status).toBe('added');
    expect(h.stored[0]).toContain('ws/faces/');
  });
  test('a repeat is a no-op and costs no vision call', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return reply; });
    await ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'synthetic', sourceRef: 'a#0' });
    expect((await ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'synthetic', sourceRef: 'a#0' })).status).toBe('exists');
    expect(calls).toBe(1);
  });
  test('rules are checked before the vision call: a named synthetic row and an unlicensed commons row are refused', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return reply; });
    await expect(ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'synthetic', sourceRef: 'x', personName: 'Someone' })).rejects.toMatchObject({ code: 'only_commons_may_name_a_person' });
    await expect(ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'commons', sourceRef: 'File:x.jpg', personName: 'Someone' })).rejects.toMatchObject({ code: 'commons_requires_licence' });
    expect(calls).toBe(0);
  });
  test('a photo with nothing measurable is skipped, not stored', async () => {
    const h = harness(async () => ({ view: 'frontal', landmarks: {} }));
    expect(await ingestImage(h.deps, 'ws', { bytes: new Uint8Array(1), source: 'synthetic', sourceRef: 'a#0' })).toEqual({ status: 'skipped', reason: 'no_usable_landmarks' });
    expect(h.stored).toEqual([]);
  });
});

describe('gallery frames', () => {
  const analysis = { shots: ['short ramus ❌', 'tall ramus ✅', 'short ramus ❌'].map((t, i) => ({ timestampSec: i * 2, description: 'face', onScreenText: t })), onScreenText: [] };
  test('a frame is cut at each overlay timestamp, labelled with the overlay verdict, and never feeds a deck', async () => {
    const h = harness();
    const at: number[] = [];
    const out = await ingestGalleryFrames(h.deps, 'ws', 'vid', analysis, async (_v, t) => { at.push(t); return new Uint8Array(1); });
    expect(at).toEqual([0, 2, 4]);
    expect(out.every(r => r.status === 'added')).toBe(true);
    expect(usableFaces(h.rows)).toEqual([]);
  });
});

describe('Commons', () => {
  test('licence normalisation accepts CC0, PD, CC-BY and refuses the rest', () => {
    expect(normaliseLicence('CC0')).toBe('CC0');
    expect(normaliseLicence('Public domain')).toBe('PD');
    expect(normaliseLicence('CC BY 4.0')).toBe('CC-BY-4.0');
    for (const bad of ['CC BY-SA 4.0', 'CC BY-NC 2.0', 'CC BY-ND 3.0', 'Fair use', 'GFDL', '', 'Attribution required']) expect(normaliseLicence(bad)).toBeNull();
  });
  const page = (licence: string, extra: Record<string, unknown> = {}) => ({
    query: { pages: [{ imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg', extmetadata: { LicenseShortName: { value: licence }, Artist: { value: '<a href="u">Jane Doe</a>' } }, ...extra }] }] },
  });
  const api = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(1) });
  test('reads licence and a tag-free credit from the file page', async () => {
    const f = await fetchCommonsFile(api(page('CC BY 4.0')), 'File:X.jpg');
    expect(f).toMatchObject({ licence: 'CC-BY-4.0', attribution: 'Jane Doe' });
  });
  test('refuses an unusable licence, a non-photo, a foreign host and a bad title', async () => {
    await expect(fetchCommonsFile(api(page('CC BY-SA 4.0')), 'File:X.jpg')).rejects.toMatchObject({ code: 'commons_licence_unusable' });
    await expect(fetchCommonsFile(api(page('CC0', { mime: 'image/svg+xml' })), 'File:X.jpg')).rejects.toMatchObject({ code: 'commons_not_a_photo' });
    await expect(fetchCommonsFile(api(page('CC0', { thumburl: 'https://evil.example/x.jpg' })), 'File:X.jpg')).rejects.toMatchObject({ code: 'commons_bad_image_url' });
    await expect(fetchCommonsFile(api(page('CC0')), 'File:a|b')).rejects.toMatchObject({ code: 'bad_commons_title' });
  });
  test('a CC-BY file lands as a named, credited, licensed row', async () => {
    const h = harness();
    const r = await ingestCommonsFile(h.deps, 'ws', api(page('CC BY 4.0')), { title: 'File:X.jpg', personName: 'Jane Doe' });
    expect(r.status).toBe('added');
    expect(h.rows[0]).toMatchObject({ source: 'commons', personName: 'Jane Doe', licence: 'CC-BY-4.0', attribution: 'Jane Doe' });
  });
});

describe('synthetic bank', () => {
  test('adds unnamed faces, one generation each', async () => {
    const h = harness();
    let gens = 0;
    const out = await ingestSyntheticFaces(h.deps, 'ws', 'bank1', 3, async () => { gens++; return new Uint8Array(1); });
    expect(out.map(r => r.status)).toEqual(['added', 'added', 'added']);
    expect(gens).toBe(3);
    expect(h.rows.every(r => r.personName === null)).toBe(true);
  });
});
