import {cardsFor, resolvePoint, subtitleBand, toCanvas, type Vec} from './geometry';
import type {Anim, Landmarks, Script} from './schema';

// Lint that needs landmarks (brief 9.2): a measure line, brackets, dots or circle that enters the subtitle band.
// Chips are moved out of the band automatically at render time, so only lines are reported.
export const lintGeometry = (s: Script, landmarks: Record<string, Landmarks>): string[] => {
  const out: string[] = [];
  s.beats.forEach((b, i) => {
    let cards;
    try {
      cards = cardsFor(b, landmarks);
    } catch {
      return;
    }
    const band = subtitleBand(b, cards);
    const anims: Anim[] = [...(b.anim ?? []), ...(b.then?.anim ?? [])];
    for (const a of anims) {
      if (a.t === 'chip') continue;
      const card = cards[a.card ?? 0] ?? cards[0];
      const lm = landmarks[card.key];
      let pts: Vec[];
      try {
        const P = (p: Parameters<typeof resolvePoint>[0]) => toCanvas(card, resolvePoint(p, lm, card.key));
        if (a.t === 'measure' || a.t === 'box') pts = [P(a.from), P(a.to)];
        else if (a.t === 'dots') pts = a.path.map(P);
        else if (a.t === 'circle') {
          const c = P(a.at);
          const r = a.r * card.dw;
          pts = [[c[0], c[1] - r], [c[0], c[1] + r]];
        } else continue;
      } catch (e) {
        out.push(`beat ${i + 1}: ${(e as Error).message}`);
        continue;
      }
      const ys = pts.map((p) => p[1]);
      const pad = a.t === 'box' ? 0.03 * card.dw : 0;
      const [y0, y1] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
      if (y1 > band[0] && y0 < band[1]) out.push(`beat ${i + 1}: ${a.t} enters the subtitle band (y ${Math.round(y0)}-${Math.round(y1)}, band ${band[0]}-${band[1]})`);
    }
  });
  return out;
};
