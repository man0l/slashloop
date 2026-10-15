// SLA-868: text for composite slides. Glyph outlines from the inlined Inter Bold
// are flattened into polygons and filled by the software canvas, so no system
// font, SVG engine or filesystem is involved.
import { Canvas, flattenGlyphPath, hexToRgb, type Point, type Rgb } from './canvas.js';
import { INTER_BOLD_LATIN_WOFF_BASE64 } from './font-data.js';

type FontFace = import('opentype.js').Font;

let fontPromise: Promise<FontFace> | null = null;
export function loadCompositeFont(): Promise<FontFace> {
  fontPromise ??= (async () => {
    const opentype = (await import('opentype.js')).default;
    const bytes = Uint8Array.from(atob(INTER_BOLD_LATIN_WOFF_BASE64), c => c.charCodeAt(0));
    return opentype.parse(bytes.buffer as ArrayBuffer);
  })();
  fontPromise.catch(() => { fontPromise = null; });
  return fontPromise;
}

const drawable = (font: FontFace, ch: string) => font.charToGlyphIndex(ch) > 0;

/** Text with glyphs the font cannot draw (emoji, rare scripts) removed. */
export function drawableText(font: FontFace, text: string): { text: string; skipped: string[] } {
  const skipped = new Set<string>();
  const kept = [...text].filter(ch => {
    if (/\s/.test(ch) || drawable(font, ch)) return true;
    skipped.add(ch);
    return false;
  }).join('').replace(/\s+/g, ' ').trim();
  return { text: kept, skipped: [...skipped] };
}

export function textWidth(font: FontFace, text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += font.getAdvanceWidth(ch, size);
  return w;
}

/** Largest size at or below `size` (down to `min`) whose width fits `maxWidth`. */
export function fitSize(font: FontFace, text: string, size: number, maxWidth: number, min: number): number {
  let s = size;
  while (s > min && textWidth(font, text, s) > maxWidth) s -= 2;
  return Math.max(min, s);
}

export function wrapText(font: FontFace, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(font, next, size) > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

export interface DrawTextOptions {
  size: number;
  color?: string;
  /** Outline colour; the stroke is drawn under the fill. */
  outline?: string;
  outlineWidth?: number;
  opacity?: number;
  align?: 'left' | 'center';
}

/** Draw one line with its left edge (or centre) at x and its baseline at y. Returns the drawn width. */
export function drawText(canvas: Canvas, font: FontFace, text: string, x: number, baseline: number, o: DrawTextOptions): number {
  const width = textWidth(font, text, o.size);
  let cursor = o.align === 'center' ? x - width / 2 : x;
  const contours: Point[][] = [];
  for (const ch of text) {
    if (ch.trim() && drawable(font, ch)) contours.push(...flattenGlyphPath(font.getPath(ch, cursor, baseline, o.size).commands));
    cursor += font.getAdvanceWidth(ch, o.size);
  }
  if (o.outline && contours.length) {
    // Eight offset copies read as an outline at slide scale and cost a fraction of a true stroke.
    const rgb: Rgb = hexToRgb(o.outline);
    const r = (o.outlineWidth ?? o.size * 0.12) / 2;
    for (let k = 0; k < 8; k++) {
      const dx = Math.cos((k / 8) * Math.PI * 2) * r;
      const dy = Math.sin((k / 8) * Math.PI * 2) * r;
      canvas.fillContours(contours.map(c => c.map(([px, py]) => [px + dx, py + dy] as Point)), rgb, 0.7);
    }
  }
  canvas.fillContours(contours, hexToRgb(o.color ?? '#ffffff'), o.opacity ?? 1);
  return width;
}
