import type {Beat, Landmarks, Point} from './schema';
import {theme} from './theme';

const {width: W, height: H} = theme.canvas;

// A card on the canvas, plus how its still is framed inside it.
export type CardRect = {
  key: string; // still key
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number; // 1 = whole still, 2 = closeup
  fx: number; // normalized focus (centre of the visible window)
  fy: number;
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

const clampFocus = (f: number, zoom: number) => Math.min(1 - 0.5 / zoom, Math.max(0.5 / zoom, f));

const makeCard = (key: string, x: number, y: number, w: number, zoom = 1, focus: Vec = [0.5, 0.5]): CardRect => ({
  key,
  x,
  y,
  w,
  h: w / theme.card.imageAspect,
  zoom,
  fx: clampFocus(focus[0], zoom),
  fy: clampFocus(focus[1], zoom),
});

// Normalized still coords -> canvas px for a card.
export const toCanvas = (c: CardRect, [px, py]: Vec): Vec => [
  c.x + ((px - c.fx) * c.zoom + 0.5) * c.w,
  c.y + ((py - c.fy) * c.zoom + 0.5) * c.h,
];

export const cardsFor = (b: Beat, landmarks: Record<string, Landmarks>): CardRect[] => {
  const {card} = theme;
  if (b.layout === 'single' && b.img) {
    const w = card.singleWidth;
    const h = w / card.imageAspect;
    const zoom = b.view === 'closeup' ? b.zoom ?? 2 : 1;
    const focus = b.focus ? resolvePoint(b.focus, landmarks[b.img], b.img) : ([0.5, 0.5] as Vec);
    return [makeCard(b.img, (W - w) / 2, (H - h) / 2, w, zoom, focus)];
  }
  if (b.layout === 'split' && b.imgs) {
    const w = card.splitWidth;
    const h = w / card.imageAspect;
    const x0 = (W - 2 * w - card.splitGap) / 2;
    return b.imgs.map((k, i) => makeCard(k, x0 + i * (w + card.splitGap), (H - h) / 2 + 20, w));
  }
  if (b.layout === 'grid2x2' && b.grid) {
    const w = card.gridWidth;
    const h = w / card.imageAspect;
    const x0 = (W - 2 * w - card.gridGap) / 2;
    const y0 = 440;
    return b.grid.map(([k], i) => makeCard(k, x0 + (i % 2) * (w + card.gridGap), y0 + Math.floor(i / 2) * (h + card.gridGap), w));
  }
  if (b.layout === 'strip' && b.imgs) {
    // Up to 7 small cards: 4 on the first row, the rest centred on the second.
    const n = b.imgs.length;
    const gap = 18;
    const perRow = n > 4 ? 4 : n;
    const w = Math.floor((W - 60 - gap * (perRow - 1)) / perRow);
    const h = w / card.imageAspect;
    const rows = Math.ceil(n / perRow);
    const top = (H - rows * h - (rows - 1) * 90) / 2 + 40;
    return b.imgs.map((k, i) => {
      const row = Math.floor(i / perRow);
      const inRow = row === rows - 1 ? n - row * perRow : perRow;
      const x0 = (W - inRow * w - (inRow - 1) * gap) / 2;
      return makeCard(k, x0 + (i - row * perRow) * (w + gap), top + row * (h + 90), w);
    });
  }
  throw new Error(`Beat layout "${b.layout}" does not match its img / imgs / grid`);
};

// Rough chip width so chips can be clamped inside the canvas without measuring the DOM.
export const chipWidth = (text: string) => text.length * theme.chip.fontSize * 0.64 + theme.chip.padX * 2;

export const clampChip = (cx: number, cy: number, text: string): Vec => {
  const half = chipWidth(text) / 2;
  const m = 24;
  return [Math.min(W - m - half, Math.max(m + half, cx)), Math.min(H - 60, Math.max(60, cy))];
};
