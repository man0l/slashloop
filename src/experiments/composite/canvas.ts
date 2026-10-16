// SLA-868: a small software rasteriser over an RGBA buffer. The composite render
// kind draws vector shapes (annotation lines, badges, glyph outlines) onto a
// photo that photon decoded, so it needs fills with anti-aliasing and nothing
// else: no system fonts, no SVG engine, no native module.
export type Rgb = readonly [number, number, number];
export type Point = readonly [number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SUBSAMPLES = 4;

export class Canvas {
  constructor(readonly width: number, readonly height: number, readonly data: Uint8Array) {
    if (data.length !== width * height * 4) throw new Error('canvas: buffer does not match dimensions');
  }

  static blank(width: number, height: number, fill: Rgb = [0, 0, 0]): Canvas {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255; }
    return new Canvas(width, height, data);
  }

  pixel(x: number, y: number): Rgb {
    const i = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }

  private blend(x: number, y: number, c: Rgb, a: number) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    d[i] = Math.round(d[i]! + (c[0] - d[i]!) * a);
    d[i + 1] = Math.round(d[i + 1]! + (c[1] - d[i + 1]!) * a);
    d[i + 2] = Math.round(d[i + 2]! + (c[2] - d[i + 2]!) * a);
    d[i + 3] = 255;
  }

  /** Fill closed contours with the non-zero winding rule, anti-aliased by vertical supersampling and exact horizontal coverage. */
  fillContours(contours: ReadonlyArray<ReadonlyArray<Point>>, color: Rgb, opacity = 1): void {
    const edges: Array<{ x0: number; y0: number; x1: number; y1: number; dir: 1 | -1 }> = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of contours) {
      for (let i = 0; i < c.length; i++) {
        const [ax, ay] = c[i]!;
        const [bx, by] = c[(i + 1) % c.length]!;
        if (ay === by) continue;
        edges.push(ay < by ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 } : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 });
        minY = Math.min(minY, ay, by);
        maxY = Math.max(maxY, ay, by);
      }
    }
    if (!edges.length) return;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const cover = new Float32Array(this.width + 1);
    for (let y = yStart; y <= yEnd; y++) {
      cover.fill(0);
      let touched = false;
      for (let s = 0; s < SUBSAMPLES; s++) {
        const sy = y + (s + 0.5) / SUBSAMPLES;
        const hits: Array<{ x: number; dir: number }> = [];
        for (const e of edges) {
          if (sy < e.y0 || sy >= e.y1) continue;
          hits.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
        }
        if (hits.length < 2) continue;
        hits.sort((a, b) => a.x - b.x);
        let winding = 0;
        for (let h = 0; h < hits.length - 1; h++) {
          winding += hits[h]!.dir;
          if (winding === 0) continue;
          const xa = Math.max(0, hits[h]!.x);
          const xb = Math.min(this.width, hits[h + 1]!.x);
          if (xb <= xa) continue;
          touched = true;
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          if (ia === ib) { cover[ia] = cover[ia]! + (xb - xa) / SUBSAMPLES; continue; }
          cover[ia] = cover[ia]! + (ia + 1 - xa) / SUBSAMPLES;
          for (let x = ia + 1; x < ib; x++) cover[x] = cover[x]! + 1 / SUBSAMPLES;
          if (ib < this.width) cover[ib] = cover[ib]! + (xb - ib) / SUBSAMPLES;
        }
      }
      if (!touched) continue;
      for (let x = 0; x < this.width; x++) {
        const a = cover[x]!;
        if (a > 0) this.blend(x, y, color, Math.min(1, a) * opacity);
      }
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb, opacity = 1): void {
    this.fillContours([[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]], color, opacity);
  }

  fillRoundedRect(x: number, y: number, w: number, h: number, r: number, color: Rgb, opacity = 1): void {
    this.fillContours([roundedRectPath(x, y, w, h, r)], color, opacity);
  }

  fillCircle(cx: number, cy: number, r: number, color: Rgb, opacity = 1): void {
    this.fillContours([circlePath(cx, cy, r)], color, opacity);
  }

  /** A stroked polyline with round joins and caps. */
  strokePolyline(points: ReadonlyArray<Point>, width: number, color: Rgb, opacity = 1): void {
    const half = width / 2;
    const contours: Point[][] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (!len) continue;
      const nx = (-(by - ay) / len) * half;
      const ny = ((bx - ax) / len) * half;
      contours.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]);
    }
    for (const [px, py] of points) contours.push(circlePath(px, py, half));
    this.fillContours(contours, color, opacity);
  }

  /** Linear vertical gradient over the whole canvas. */
  fillVerticalGradient(top: Rgb, bottom: Rgb): void {
    for (let y = 0; y < this.height; y++) {
      const t = y / Math.max(1, this.height - 1);
      const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
      const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
      const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
      }
    }
  }
}

export function circlePath(cx: number, cy: number, r: number, steps = 32): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Point;
  });
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): Point[] {
  const rr = Math.min(r, w / 2, h / 2);
  const out: Point[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = from + (i / 8) * (Math.PI / 2);
      out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  };
  corner(x + w - rr, y + rr, -Math.PI / 2);
  corner(x + w - rr, y + h - rr, 0);
  corner(x + rr, y + h - rr, Math.PI / 2);
  corner(x + rr, y + rr, Math.PI);
  return out;
}

/** Flatten an opentype.js path (M/L/Q/C/Z commands) into closed polygons. */
export function flattenGlyphPath(commands: ReadonlyArray<{ type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }>): Point[][] {
  const contours: Point[][] = [];
  let cur: Point[] = [];
  let px = 0;
  let py = 0;
  const flush = () => { if (cur.length > 2) contours.push(cur); cur = []; };
  for (const c of commands) {
    if (c.type === 'M') { flush(); px = c.x!; py = c.y!; cur.push([px, py]); }
    else if (c.type === 'L') { px = c.x!; py = c.y!; cur.push([px, py]); }
    else if (c.type === 'Q') {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8; const u = 1 - t;
        cur.push([u * u * px + 2 * u * t * c.x1! + t * t * c.x!, u * u * py + 2 * u * t * c.y1! + t * t * c.y!]);
      }
      px = c.x!; py = c.y!;
    } else if (c.type === 'C') {
      for (let i = 1; i <= 10; i++) {
        const t = i / 10; const u = 1 - t;
        cur.push([
          u * u * u * px + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t * t * t * c.x!,
          u * u * u * py + 3 * u * u * t * c.y1! + 3 * u * t * t * c.y2! + t * t * t * c.y!,
        ]);
      }
      px = c.x!; py = c.y!;
    } else if (c.type === 'Z') flush();
  }
  flush();
  return contours;
}
