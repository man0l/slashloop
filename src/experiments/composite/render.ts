// SLA-868: rasterise composite slides. A library photo is decoded and cover-fit
// to 9:16 by photon, everything drawn over it (annotation, badge, label, credit
// line) is vector work on the software canvas, and the result is re-encoded by
// photon. No image-model call happens anywhere on this path.
import { Canvas, hexToRgb, type Point } from './canvas.js';
import type { Landmarks, Point as LandmarkPoint } from './landmarks.js';
import type { FaceSlideT, ScoreCardSlideT } from './plan.js';
import { BADGE_COLORS } from './plan.js';
import { drawableText, drawText, fitSize, loadCompositeFont, textWidth, wrapText } from './text.js';

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1920;
const JPEG_QUALITY = 90;

export interface RenderedSlide {
  buffer: Buffer;
  contentType: 'image/jpeg';
  /** Characters of the label no bundled font covers; they are not drawn. */
  skipped: string[];
}

async function photon() {
  return import('@cf-wasm/photon');
}

/** Decode `bytes` and cover-fit it to the slide; returns the canvas and the mapping from source pixels to slide pixels. */
export async function loadPhotoCanvas(bytes: Uint8Array): Promise<{ canvas: Canvas; map: (p: LandmarkPoint) => Point }> {
  const ph = await photon();
  const src = ph.PhotonImage.new_from_byteslice(bytes);
  const w = src.get_width();
  const h = src.get_height();
  if (!w || !h) throw new Error('composite: unreadable face photo');
  const scale = Math.max(SLIDE_WIDTH / w, SLIDE_HEIGHT / h);
  const rw = Math.max(SLIDE_WIDTH, Math.round(w * scale));
  const rh = Math.max(SLIDE_HEIGHT, Math.round(h * scale));
  const resized = ph.resize(src, rw, rh, ph.SamplingFilter.Lanczos3);
  const raw = resized.get_raw_pixels();
  const offX = Math.floor((rw - SLIDE_WIDTH) / 2);
  const offY = Math.floor((rh - SLIDE_HEIGHT) / 2);
  const data = new Uint8Array(SLIDE_WIDTH * SLIDE_HEIGHT * 4);
  for (let y = 0; y < SLIDE_HEIGHT; y++) {
    const from = ((y + offY) * rw + offX) * 4;
    data.set(raw.subarray(from, from + SLIDE_WIDTH * 4), y * SLIDE_WIDTH * 4);
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  src.free();
  resized.free();
  return {
    canvas: new Canvas(SLIDE_WIDTH, SLIDE_HEIGHT, data),
    map: p => [p.x * (rw / w) - offX, p.y * (rh / h) - offY],
  };
}

export async function encodeJpeg(canvas: Canvas): Promise<Buffer> {
  const ph = await photon();
  const image = new ph.PhotonImage(canvas.data, canvas.width, canvas.height);
  const bytes = image.get_bytes_jpeg(JPEG_QUALITY);
  image.free();
  return Buffer.from(bytes);
}

/** Darken the bottom of the frame so the label stays legible on any photo. */
function scrim(canvas: Canvas, fromY: number, maxAlpha: number) {
  const d = canvas.data;
  for (let y = Math.max(0, Math.floor(fromY)); y < canvas.height; y++) {
    const t = (y - fromY) / (canvas.height - fromY);
    const keep = 1 - maxAlpha * Math.min(1, t * 1.6);
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      d[i] = Math.round(d[i]! * keep); d[i + 1] = Math.round(d[i + 1]! * keep); d[i + 2] = Math.round(d[i + 2]! * keep);
    }
  }
}

function arrowHead(canvas: Canvas, from: Point, to: Point, size: number, color: ReturnType<typeof hexToRgb>) {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const wing = (delta: number): Point => [to[0] - Math.cos(ang + delta) * size, to[1] - Math.sin(ang + delta) * size];
  canvas.fillContours([[to, wing(0.45), wing(-0.45)]], color);
}

function drawAnnotation(canvas: Canvas, slide: FaceSlideT, landmarks: Landmarks, map: (p: LandmarkPoint) => Point) {
  const a = slide.annotation;
  const fromLm = landmarks[a.from];
  const toLm = landmarks[a.to];
  if (!fromLm || !toLm) throw new Error(`composite: face has no ${!fromLm ? a.from : a.to} landmark`);
  const from = map(fromLm);
  const to = map(toLm);
  const color = hexToRgb(a.color);
  const white = hexToRgb('#ffffff');
  const width = 9;
  let path: Point[] = [from, to];
  if (a.kind === 'bracket' && landmarks.earTragus) path = [map(landmarks.earTragus), from, to];
  // A dark under-stroke keeps the line readable on pale skin and bright backgrounds.
  canvas.strokePolyline(path, width + 6, [0, 0, 0], 0.45);
  canvas.strokePolyline(path, width, color);
  if (a.kind === 'arrow') arrowHead(canvas, from, to, 46, color);
  for (const p of a.kind === 'bracket' ? path : [from, to]) {
    canvas.fillCircle(p[0], p[1], 17, [0, 0, 0], 0.5);
    canvas.fillCircle(p[0], p[1], 13, white);
    canvas.fillCircle(p[0], p[1], 8, color);
  }
}

/** A tick or cross drawn as strokes: emoji glyphs are not in the bundled font. */
function drawVerdictMark(canvas: Canvas, cx: number, cy: number, r: number, verdict: 'pos' | 'neg') {
  canvas.fillCircle(cx, cy, r, hexToRgb(BADGE_COLORS[verdict]));
  const white = hexToRgb('#ffffff');
  const k = r * 0.46;
  const w = r * 0.28;
  if (verdict === 'pos') canvas.strokePolyline([[cx - k, cy + k * 0.05], [cx - k * 0.25, cy + k * 0.75], [cx + k * 1.05, cy - k * 0.7]], w, white);
  else {
    canvas.strokePolyline([[cx - k, cy - k], [cx + k, cy + k]], w, white);
    canvas.strokePolyline([[cx + k, cy - k], [cx - k, cy + k]], w, white);
  }
}

export async function renderFaceSlide(photo: Uint8Array, slide: FaceSlideT, landmarks: Landmarks): Promise<RenderedSlide> {
  const font = await loadCompositeFont();
  const { canvas, map } = await loadPhotoCanvas(photo);
  scrim(canvas, SLIDE_HEIGHT * 0.62, 0.62);
  drawAnnotation(canvas, slide, landmarks, map);

  const { text, skipped } = drawableText(font, slide.label);
  const markR = 62;
  const gap = 28;
  const size = fitSize(font, text, 92, SLIDE_WIDTH * 0.84 - markR * 2 - gap, 40);
  const textW = textWidth(font, text, size);
  const total = markR * 2 + gap + textW;
  const left = (SLIDE_WIDTH - total) / 2;
  const cy = SLIDE_HEIGHT * 0.72;
  drawVerdictMark(canvas, left + markR, cy, markR, slide.badge);
  drawText(canvas, font, text, left + markR * 2 + gap, cy + size * 0.35, { size, outline: '#000000' });

  if (slide.attribution) {
    const credit = drawableText(font, slide.attribution).text;
    const cs = fitSize(font, credit, 26, SLIDE_WIDTH * 0.9, 18);
    const lines = wrapText(font, credit, cs, SLIDE_WIDTH * 0.9, 2);
    lines.forEach((line, i) => drawText(canvas, font, line, SLIDE_WIDTH / 2, SLIDE_HEIGHT - 150 + i * cs * 1.3, { size: cs, align: 'center', opacity: 0.85, outline: '#000000', outlineWidth: 3 }));
  }
  return { buffer: await encodeJpeg(canvas), contentType: 'image/jpeg', skipped };
}

/** Tier colour for the closing card: a plain bucketing of the score, nothing else. */
export function scoreColor(score: number): string {
  if (score >= 7.5) return '#22c55e';
  if (score >= 5.5) return '#eab308';
  return '#ef4444';
}

export async function renderScoreCard(slide: ScoreCardSlideT): Promise<RenderedSlide> {
  const font = await loadCompositeFont();
  const canvas = Canvas.blank(SLIDE_WIDTH, SLIDE_HEIGHT);
  canvas.fillVerticalGradient([18, 18, 28], [6, 6, 10]);
  const accent = scoreColor(slide.score);
  const skipped = new Set<string>();
  const clean = (s: string) => { const d = drawableText(font, s); d.skipped.forEach(c => skipped.add(c)); return d.text; };

  const app = clean(slide.appName).toUpperCase();
  drawText(canvas, font, app, SLIDE_WIDTH / 2, 430, { size: fitSize(font, app, 64, SLIDE_WIDTH * 0.8, 28), align: 'center', color: '#a3a3b8' });

  const score = slide.score.toFixed(1);
  const scoreSize = 420;
  const scoreW = textWidth(font, score, scoreSize);
  const outOf = '/10';
  const outSize = 110;
  const outW = textWidth(font, outOf, outSize);
  const startX = (SLIDE_WIDTH - (scoreW + 16 + outW)) / 2;
  drawText(canvas, font, score, startX, 980, { size: scoreSize, color: accent });
  drawText(canvas, font, outOf, startX + scoreW + 16, 980, { size: outSize, color: '#a3a3b8' });

  const barX = SLIDE_WIDTH * 0.12;
  const barW = SLIDE_WIDTH * 0.76;
  canvas.fillRoundedRect(barX, 1060, barW, 30, 15, hexToRgb('#2a2a3a'));
  canvas.fillRoundedRect(barX, 1060, Math.max(30, (barW * slide.score) / 10), 30, 15, hexToRgb(accent));

  const name = clean(slide.name);
  drawText(canvas, font, name, SLIDE_WIDTH / 2, 1250, { size: fitSize(font, name, 84, SLIDE_WIDTH * 0.84, 36), align: 'center' });
  if (slide.tier) {
    const tier = clean(slide.tier).toUpperCase();
    const ts = fitSize(font, tier, 54, SLIDE_WIDTH * 0.6, 28);
    const tw = textWidth(font, tier, ts);
    canvas.fillRoundedRect((SLIDE_WIDTH - tw) / 2 - 36, 1310, tw + 72, ts + 44, (ts + 44) / 2, hexToRgb(accent), 0.22);
    drawText(canvas, font, tier, SLIDE_WIDTH / 2, 1310 + ts + 12, { size: ts, align: 'center', color: accent });
  }
  return { buffer: await encodeJpeg(canvas), contentType: 'image/jpeg', skipped: [...skipped] };
}
