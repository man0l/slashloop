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

// Canvas y-range of a beat's lines / brackets / dots / circles on one card (chips excluded: they move themselves).
export const animYRange = (b: Beat, card: CardRect, lm: Landmarks | undefined, cardIndex = 0): [number, number] | null => {
  const ys: number[] = [];
  for (const a of [...(b.anim ?? []), ...(b.then?.anim ?? [])]) {
    if (a.t === 'chip' || a.t === 'cite' || (a.card ?? 0) !== cardIndex) continue;
    try {
      const P = (p: Point) => toCanvas(card, resolvePoint(p, lm, card.key))[1];
      if (a.t === 'measure' || a.t === 'box') {
        const pad = a.t === 'box' ? (a.pad ?? 0.03) * card.dw : 0;
        ys.push(Math.min(P(a.from), P(a.to)) - pad, Math.max(P(a.from), P(a.to)) + pad);
      } else if (a.t === 'dots') ys.push(...a.path.map(P));
      else if (a.t === 'circle') ys.push(P(a.at) - a.r * card.dw, P(a.at) + a.r * card.dw);
    } catch {
      /* missing landmark: reported by lint */
    }
  }
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
};

// Brief 9.2 on full-bleed beats: if a line would enter the subtitle band, zoom in and move the photo up
// (focus lower) just enough to clear it, up to 1.8x; null when even that is not enough.
const fitAboveBand = (b: Beat, card: CardRect, lm: Landmarks | undefined, focus: Vec | undefined): CardRect | null => {
  if (!b.subs || b.view === 'closeup') return card;
  const limit = SUBTITLE_BAND[0] - 24;
  const r = animYRange(b, card, lm);
  if (!r || r[1] <= limit) return card;
  const fx = focus?.[0] ?? card.fx;
  for (let z = Math.max(card.zoom, 1.05); z <= 1.8 + 1e-6; z += 0.05) {
    // Lowest focus first = photo pushed up the most; makeCard clamps it to the still's edge.
    for (let fy = 0.95; fy >= card.fy; fy -= 0.02) {
      const c = makeCard(card.key, card.x, card.y, card.w, card.h, z, [fx, fy], true);
      const rr = animYRange(b, c, lm);
      if (rr && rr[1] <= limit && rr[0] >= 380) return c;
    }
  }
  return null;
};

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
    const bleed = makeCard(b.img, 0, H - h, W, h, b.zoom ?? 1, focus, true);
    const fitted = fitAboveBand(b, bleed, landmarks[b.img], focus);
    if (fitted) return [fitted];
    // Even 1.8x cannot lift the lines out of the band: fall back to the rounded card, whose band is its own bottom strip.
    const w = card.singleWidth;
    return [makeCard(b.img, (W - w) / 2, 560, w, w / A, 1, focus)];
  }
  if (b.layout === 'split' && b.imgs) {
    const w = card.splitWidth;
    const h = w / A;
    const x0 = (W - 2 * w - card.splitGap) / 2;
    // Optional beat zoom / focus applies to both cards (paired close-ups, e.g. one eye at 3x on each face).
    return b.imgs.map((k, i) =>
      makeCard(k, x0 + i * (w + card.splitGap), 560, w, h, b.zoom ?? 1, b.focus ? resolvePoint(b.focus, landmarks[k], k) : undefined),
    );
  }
  if (b.layout === 'grid2x2' && b.grid) {
    const w = card.gridWidth;
    const h = w / A;
    const x0 = (W - 2 * w - card.gridGap) / 2;
    const y0 = 380;
    return b.grid.map(([k], i) => makeCard(k, x0 + (i % 2) * (w + card.gridGap), y0 + Math.floor(i / 2) * (h + card.gridGap + 30), w, h));
  }
  if (b.layout === 'strip' && b.imgs && b.imgs.length <= 5) {
    // Ladder payoff: up to 5 cards on one row (190 px each), values above, labels below.
    const {width: w, gap, top} = theme.strip;
    const x0 = (W - b.imgs.length * w - (b.imgs.length - 1) * gap) / 2;
    return b.imgs.map((k, i) => makeCard(k, x0 + i * (w + gap), top, w, w / A, b.zoom ?? 1, b.focus ? resolvePoint(b.focus, landmarks[k], k) : undefined));
  }
  if (b.layout === 'strip' && b.imgs) {
    // 6-7 small cards: 4 on the first row, the rest centred on the second.
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

// Subtitle band (brief 9.2): canvas y 1420-1580, or the bottom 160 px of a single rounded card, where the
// subtitles sit on card beats. Lines, brackets and chips must stay out of it.
export const SUBTITLE_BAND: [number, number] = [1420, 1580];
export const subtitleBand = (b: Beat, cards: CardRect[]): [number, number] => {
  const c = cards[0];
  if (b.layout === 'single' && c && !c.bleed) return [c.y + c.h - 160, c.y + c.h];
  return SUBTITLE_BAND;
};
