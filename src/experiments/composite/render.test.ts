// SLA-868: the composite rasteriser draws the annotation, badge and label over a
// library photo with no image-model call. Pixel checks against a flat grey photo
// (JPEG-tolerant) prove each element lands where the landmarks say.
import { describe, expect, test } from 'bun:test';
import { loadPhotoCanvas, renderFaceSlide, renderScoreCard, SLIDE_HEIGHT, SLIDE_WIDTH } from './render.js';
import type { FaceSlideT } from './plan.js';
import type { Landmarks } from './landmarks.js';

async function flatPhoto(w: number, h: number, grey = 120): Promise<Uint8Array> {
  const { PhotonImage } = await import('@cf-wasm/photon');
  const raw = new Uint8Array(w * h * 4).fill(grey);
  for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
  return new PhotonImage(raw, w, h).get_bytes_jpeg(95);
}
async function decode(bytes: Uint8Array) {
  const { PhotonImage } = await import('@cf-wasm/photon');
  const img = PhotonImage.new_from_byteslice(bytes);
  return { w: img.get_width(), h: img.get_height(), px: img.get_raw_pixels() };
}
const at = (d: { w: number; px: Uint8Array }, x: number, y: number) => {
  const i = (Math.round(y) * d.w + Math.round(x)) * 4;
  return [d.px[i]!, d.px[i + 1]!, d.px[i + 2]!];
};

// 540x960 photo: slide scale 2, no crop offset.
const landmarks: Landmarks = {
  gonion: { x: 200, y: 600 }, earTragus: { x: 320, y: 450 }, nasion: { x: 270, y: 330 }, chin: { x: 250, y: 720 },
};
const slide = (over: Partial<FaceSlideT> = {}): FaceSlideT => ({
  type: 'face', faceId: 'f1', feature: 'ramus',
  annotation: { kind: 'line', from: 'gonion', to: 'earTragus', color: '#22c55e' },
  badge: 'pos', label: 'tall ramus', ...over,
});

describe('renderFaceSlide (SLA-868)', () => {
  test('outputs a 1080x1920 JPEG', async () => {
    const out = await renderFaceSlide(await flatPhoto(540, 960), slide(), landmarks);
    expect(out.contentType).toBe('image/jpeg');
    const d = await decode(out.buffer);
    expect([d.w, d.h]).toEqual([SLIDE_WIDTH, SLIDE_HEIGHT]);
  }, 30000);

  test('the annotation line runs between its two landmarks in slide pixels', async () => {
    const d = await decode((await renderFaceSlide(await flatPhoto(540, 960), slide(), landmarks)).buffer);
    const [r, g, b] = at(d, 520, 1050); // midpoint of (400,1200)-(640,900) at scale 2 is (520,1050)
    expect(g).toBeGreaterThan(r + 40);
    expect(g).toBeGreaterThan(b + 40);
    const [gr, gg, gb] = at(d, 900, 300);
    expect(Math.abs(gr - 120) + Math.abs(gg - 120) + Math.abs(gb - 120)).toBeLessThan(30);
  }, 30000);

  test('negative badge draws red, positive green, at the label row', async () => {
    const photo = await flatPhoto(540, 960);
    const neg = await decode((await renderFaceSlide(photo, slide({ badge: 'neg', label: 'short ramus', annotation: { kind: 'line', from: 'gonion', to: 'earTragus', color: '#ef4444' } }), landmarks)).buffer);
    const pos = await decode((await renderFaceSlide(photo, slide(), landmarks)).buffer);
    const row = SLIDE_HEIGHT * 0.72;
    const scan = (d: typeof neg) => {
      let best = [0, 0, 0];
      for (let x = 100; x < SLIDE_WIDTH - 100; x += 4) { const p = at(d, x, row - 40); if (Math.abs(p[0]! - p[1]!) > Math.abs(best[0]! - best[1]!)) best = p; }
      return best;
    };
    const n = scan(neg); const p = scan(pos);
    expect(n[0]).toBeGreaterThan(n[1]! + 80);
    expect(p[1]).toBeGreaterThan(p[0]! + 60);
  }, 30000);

  test('label text is drawn: the label row differs from a blank row', async () => {
    const d = await decode((await renderFaceSlide(await flatPhoto(540, 960), slide(), landmarks)).buffer);
    let bright = 0;
    for (let x = 0; x < SLIDE_WIDTH; x++) { const [r, g, b] = at(d, x, SLIDE_HEIGHT * 0.72); if (r! > 200 && g! > 200 && b! > 200) bright++; }
    expect(bright).toBeGreaterThan(20);
  }, 30000);

  test('attribution line is drawn only when the slide carries one', async () => {
    const photo = await flatPhoto(540, 960);
    const bright = async (s: FaceSlideT) => {
      const d = await decode((await renderFaceSlide(photo, s, landmarks)).buffer);
      let n = 0;
      for (let y = SLIDE_HEIGHT - 175; y < SLIDE_HEIGHT - 110; y++) for (let x = 0; x < SLIDE_WIDTH; x += 2) { const [r, g, b] = at(d, x, y); if (r! > 170 && g! > 170 && b! > 170) n++; }
      return n;
    };
    expect(await bright(slide())).toBe(0);
    expect(await bright(slide({ attribution: 'Jane Doe / Wikimedia Commons / CC BY 4.0' }))).toBeGreaterThan(40);
  }, 30000);

  test('a missing landmark fails loudly instead of drawing a wrong line', async () => {
    const { earTragus, ...rest } = landmarks;
    await expect(renderFaceSlide(await flatPhoto(540, 960), slide(), rest)).rejects.toThrow(/earTragus/);
  }, 30000);

  test('a wide photo is cover-fit and landmarks follow the crop', async () => {
    const { map } = await loadPhotoCanvas(await flatPhoto(1920, 1080));
    // scale 1920/1080 = 1.7778: the 1080-wide window is centred, so source x=960 lands mid-slide.
    expect(Math.abs(map({ x: 960, y: 540 })[0] - SLIDE_WIDTH / 2)).toBeLessThan(1);
    expect(Math.abs(map({ x: 960, y: 540 })[1] - SLIDE_HEIGHT / 2)).toBeLessThan(1);
  }, 30000);
});

describe('renderScoreCard (SLA-868)', () => {
  test('renders a 1080x1920 card and reports uncovered glyphs', async () => {
    const out = await renderScoreCard({ type: 'score_card', appName: 'PSL', name: 'Your result ✅', score: 7.2, tier: 'High tier' });
    const d = await decode(out.buffer);
    expect([d.w, d.h]).toEqual([SLIDE_WIDTH, SLIDE_HEIGHT]);
    expect(out.skipped).toContain('✅');
  }, 30000);
});
