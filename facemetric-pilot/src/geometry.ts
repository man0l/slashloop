import type {Beat, Landmarks, Point} from './schema';
import {theme} from './theme';

const {width: W, height: H} = theme.canvas;

// A box on the canvas showing a still, cover-fitted, zoomed around a focus point.
export type CardRect = {
  key: string; // still key
  x: number;
  y: number;
  w: number;
  h: number;
  dw: number; // displayed still width (cover fit x zoom)
  dh: number;
  fx: number; // normalized focus = still point at the box centre
  fy: number;
  zoom: number;
  bleed: boolean; // full-bleed photo (no card chrome)
};

export type Vec = [number, number];

// Landmark name / offset / raw coords -> normalized still coords.
export const resolvePoint = (p: Point, lm: Landmarks | undefined, key: string): Vec => {
  if (Array.isArray(p) && typeof p[0] === 'number') return [p[0], p[1] as number];
  const [name, dx, dy] = typeof p === 'string' ? [p, 0, 0] : (p as [string, number, number]);
  const v = lm?.[name];
  if (!v) {
    throw new Error(`Landmark "${name}" missing for still "${key}". Run: npx tsx tools/landmarks.ts <reel>`);
  }
  return [v[0] + dx, v[1] + dy];
};

const makeCard = (key: string, x: number, y: number, w: number, h: number, zoom = 1, focus: Vec = [0.5, 0.5], bleed = false): CardRect => {
  const a = theme.card.imageAspect;
  const iw = Math.max(w, h * a); // cover fit
  const dw = iw * zoom;
  const dh = (iw / a) * zoom;
  const clamp = (f: number, box: number, d: number) => Math.min(1 - box / (2 * d), Math.max(box / (2 * d), f));
  return {key, x, y, w, h, dw, dh, fx: clamp(focus[0], w, dw), fy: clamp(focus[1], h, dh), zoom, bleed};
};

// Normalized still coords -> canvas px.
export const toCanvas = (c: CardRect, [px, py]: Vec): Vec => [c.x + c.w / 2 + (px - c.fx) * c.dw, c.y + c.h / 2 + (py - c.fy) * c.dh];

export const cardsFor = (b: Beat, landmarks: Record<string, Landmarks>): CardRect[] => {
  const {card} = theme;
  const A = card.imageAspect;
  if (b.layout === 'single' && b.img) {
    const focus = b.focus ? resolvePoint(b.focus, landmarks[b.img], b.img) : undefined;
    if (b.view === 'closeup') {
      // Reference hooks: the close-up fills the whole frame.
      return [makeCard(b.img, 0, 0, W, H, b.zoom ?? 2, focus ?? [0.5, 0.6], true)];
    }
    if (b.card) {
      const w = card.singleWidth;
      const h = w / A;
      return [makeCard(b.img, (W - w) / 2, 560, w, h, 1, focus)];
    }
    // Full-bleed: the photo spans the width and sits on the bottom edge; its top fades into the canvas.
    const h = W / A;
    return [makeCard(b.img, 0, H - h, W, h, b.zoom ?? 1, focus, true)];
  }
  if (b.layout === 'split' && b.imgs) {
    const w = card.splitWidth;
    const h = w / A;
    const x0 = (W - 2 * w - card.splitGap) / 2;
    return b.imgs.map((k, i) => makeCard(k, x0 + i * (w + card.splitGap), 560, w, h));
  }
  if (b.layout === 'grid2x2' && b.grid) {
    const w = card.gridWidth;
    const h = w / A;
    const x0 = (W - 2 * w - card.gridGap) / 2;
    const y0 = 380;
    return b.grid.map(([k], i) => makeCard(k, x0 + (i % 2) * (w + card.gridGap), y0 + Math.floor(i / 2) * (h + card.gridGap + 30), w, h));
  }
  if (b.layout === 'strip' && b.imgs) {
    // Up to 7 small cards: 4 on the first row, the rest centred on the second.
    const n = b.imgs.length;
    const gap = 18;
    const perRow = n > 4 ? 4 : n;
    const w = Math.floor((W - 60 - gap * (perRow - 1)) / perRow);
    const h = w / A;
    const rows = Math.ceil(n / perRow);
    const top = (H - rows * h - (rows - 1) * 90) / 2 + 40;
    return b.imgs.map((k, i) => {
      const row = Math.floor(i / perRow);
      const inRow = row === rows - 1 ? n - row * perRow : perRow;
      const x0 = (W - inRow * w - (inRow - 1) * gap) / 2;
      return makeCard(k, x0 + (i - row * perRow) * (w + gap), top + row * (h + 90), w, h);
    });
  }
  throw new Error(`Beat layout "${b.layout}" does not match its img / imgs / grid`);
};

// Rough chip width so chips can be clamped inside the canvas without measuring the DOM.
export const chipWidth = (text: string, check = false) =>
  text.length * theme.chip.fontSize * 0.74 + theme.chip.padX * 2 + (check ? theme.chip.checkSize + 10 : 0);

export const clampChip = (cx: number, cy: number, text: string, check = false): Vec => {
  const half = chipWidth(text, check) / 2;
  const m = 24;
  return [Math.min(W - m - half, Math.max(m + half, cx)), Math.min(H - 60, Math.max(60, cy))];
};
