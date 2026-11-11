// Face-shape outlines as SVG paths in a normalised face space:
//   u: -1 (viewer's left cheek edge) … +1 (right cheek edge)
//   v:  0 (hairline)                 …  1 (bottom of chin)
// toPath() maps that space onto a concrete face box in pixels.

export type ShapeId = 'oval' | 'oblong' | 'round' | 'heart' | 'diamond' | 'triangle' | 'square';

type Cmd = [string, ...number[]];

const TEMPLATES: Record<ShapeId, Cmd[]> = {
  oval: [
    ['M', 0, 0],
    ['C', 0.6, 0, 0.9, 0.2, 0.9, 0.45],
    ['C', 0.9, 0.78, 0.5, 1, 0, 1],
    ['C', -0.5, 1, -0.9, 0.78, -0.9, 0.45],
    ['C', -0.9, 0.2, -0.6, 0, 0, 0],
  ],
  oblong: [
    ['M', -0.62, 0.12],
    ['Q', -0.62, 0, -0.45, 0],
    ['L', 0.45, 0],
    ['Q', 0.62, 0, 0.62, 0.12],
    ['L', 0.62, 0.85],
    ['Q', 0.62, 1, 0.35, 1],
    ['L', -0.35, 1],
    ['Q', -0.62, 1, -0.62, 0.85],
    ['Z'],
  ],
  round: [
    ['M', 0, 0.02],
    ['C', 0.62, 0.02, 1.02, 0.25, 1.02, 0.52],
    ['C', 1.02, 0.82, 0.6, 1, 0, 1],
    ['C', -0.6, 1, -1.02, 0.82, -1.02, 0.52],
    ['C', -1.02, 0.25, -0.62, 0.02, 0, 0.02],
  ],
  heart: [
    ['M', 0, 0.1],
    ['C', 0.25, -0.04, 0.95, -0.02, 0.98, 0.3],
    ['C', 1, 0.6, 0.45, 0.86, 0, 1],
    ['C', -0.45, 0.86, -1, 0.6, -0.98, 0.3],
    ['C', -0.95, -0.02, -0.25, -0.04, 0, 0.1],
  ],
  diamond: [
    ['M', 0, -0.02],
    ['L', 1, 0.47],
    ['L', 0, 1],
    ['L', -1, 0.47],
    ['Z'],
  ],
  triangle: [
    ['M', -0.4, 0.02],
    ['L', 0.4, 0.02],
    ['L', 0.95, 0.74],
    ['Q', 0.95, 0.96, 0.55, 1],
    ['L', -0.55, 1],
    ['Q', -0.95, 0.96, -0.95, 0.74],
    ['Z'],
  ],
  square: [
    ['M', -0.9, 0.02],
    ['L', 0.9, 0.02],
    ['L', 0.9, 0.8],
    ['Q', 0.9, 1, 0.6, 1],
    ['L', -0.6, 1],
    ['Q', -0.9, 1, -0.9, 0.8],
    ['Z'],
  ],
};

export interface FaceBox {
  cx: number; // centre x in px
  top: number; // hairline y in px
  height: number; // hairline → chin in px
  halfWidth: number; // centre → cheek edge in px
}

export function toPath(id: ShapeId, box: FaceBox): string {
  return TEMPLATES[id]
    .map(([c, ...n]) => {
      const pts: string[] = [];
      for (let i = 0; i < n.length; i += 2) {
        pts.push(`${(box.cx + n[i] * box.halfWidth).toFixed(1)} ${(box.top + n[i + 1] * box.height).toFixed(1)}`);
      }
      return `${c} ${pts.join(' ')}`.trim();
    })
    .join(' ');
}
