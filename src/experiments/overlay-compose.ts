// SLA-787: draws slide overlay text in code, so the image model never sees the
// copy. Glyph outlines come from opentype.js and are rasterised by sharp as a
// path-only SVG, which keeps the result independent of system fonts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface ComposedOverlay {
  buffer: Buffer;
  contentType: 'image/jpeg';
  font: string;
  fontSize: number;
  lines: string[];
  /** Characters no bundled font covers (emoji, rare scripts); they are not drawn. */
  skipped: string[];
}

type FontFace = import('opentype.js').Font;
const FONT_FILES = ['inter-latin-700-normal.woff', 'inter-latin-ext-700-normal.woff', 'inter-cyrillic-700-normal.woff'];
export const OVERLAY_FONT_NAME = 'Inter Bold';

let fontsPromise: Promise<FontFace[]> | null = null;
function loadFonts(): Promise<FontFace[]> {
  fontsPromise ??= (async () => {
    const opentype = (await import('opentype.js')).default;
    const root = dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json'));
    return FONT_FILES.map(file => {
      const data = readFileSync(join(root, 'files', file));
      return opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    });
  })();
  fontsPromise.catch(() => { fontsPromise = null; });
  return fontsPromise;
}

const fontFor = (fonts: FontFace[], char: string): FontFace | null =>
  fonts.find(f => f.charToGlyphIndex(char) > 0) ?? null;

function advance(fonts: FontFace[], text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    const font = fontFor(fonts, char);
    if (font) width += font.getAdvanceWidth(char, size);
  }
  return width;
}

function wrap(fonts: FontFace[], text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && advance(fonts, next, size) > maxWidth) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

const MAX_LINES = 7;
const LINE_HEIGHT = 1.18;
/** SLA-867: a stacked label's subtitle lines are drawn at this share of the title size. */
export const SUBTITLE_SCALE = 0.5;

/** Slide 1 (the hook) is centred; later slides sit in the upper third. Both stay
 *  clear of the platform UI bands at the top and bottom of a 9:16 frame.
 *  `stacked` (SLA-867): the first line of the text is a title and every later line a
 *  smaller subtitle under it ("TITLE\nsubtitle"), as on a ladder carousel's labels. */
export async function composeOverlay(opts: { buffer: Buffer; text: string; slideIndex: number; stacked?: boolean }): Promise<ComposedOverlay> {
  const text = opts.text.replace(/[ \t]+/g, ' ').trim();
  const breakAt = opts.stacked ? text.search(/\r?\n/) : -1;
  if (breakAt > 0) return composeStacked(opts, text.slice(0, breakAt).trim(), text.slice(breakAt).trim());
  if (!text) return { buffer: opts.buffer, contentType: 'image/jpeg', font: OVERLAY_FONT_NAME, fontSize: 0, lines: [], skipped: [] };
  const [fonts, sharpModule] = await Promise.all([loadFonts(), import('sharp')]);
  const sharp = sharpModule.default;
  const meta = await sharp(opts.buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('overlay_compose: unreadable image');
  const skipped = [...new Set([...text].filter(c => !/\s/.test(c) && !fontFor(fonts, c)))];
  const drawable = skipped.length ? [...text].filter(c => !skipped.includes(c)).join('') : text;
  const maxWidth = width * 0.84;
  const maxBlockHeight = height * 0.46;
  let size = Math.round(width * (opts.slideIndex === 0 ? 0.095 : 0.078));
  const minSize = Math.round(width * 0.03);
  let lines = wrap(fonts, drawable, size, maxWidth);
  while (size > minSize && (lines.length > MAX_LINES || lines.length * size * LINE_HEIGHT > maxBlockHeight
    || lines.some(l => advance(fonts, l, size) > maxWidth))) {
    size = Math.max(minSize, size - 2);
    lines = wrap(fonts, drawable, size, maxWidth);
  }
  const lineHeight = size * LINE_HEIGHT;
  const blockHeight = lines.length * lineHeight;
  const centre = height * (opts.slideIndex === 0 ? 0.5 : 0.26);
  const top = Math.min(Math.max(centre - blockHeight / 2, height * 0.1), height * 0.8 - blockHeight);
  const paths: string[] = [];
  lines.forEach((line, row) => {
    let x = (width - advance(fonts, line, size)) / 2;
    const baseline = top + row * lineHeight + size;
    for (const char of line) {
      const font = fontFor(fonts, char);
      if (!font) continue;
      if (char.trim()) paths.push(font.getPath(char, x, baseline, size).toPathData(2));
      x += font.getAdvanceWidth(char, size);
    }
  });
  const d = paths.join(' ');
  const stroke = (size * 0.16).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<path d="${d}" fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<path d="${d}" fill="#fff"/></svg>`;
  const buffer = await sharp(opts.buffer).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { buffer, contentType: 'image/jpeg', font: OVERLAY_FONT_NAME, fontSize: size, lines, skipped };
}

/** Title and subtitle as two blocks, each wrapped and fitted on its own, the subtitle at SUBTITLE_SCALE of the title. */
async function composeStacked(opts: { buffer: Buffer; slideIndex: number }, title: string, subtitle: string): Promise<ComposedOverlay> {
  const [fonts, sharpModule] = await Promise.all([loadFonts(), import('sharp')]);
  const sharp = sharpModule.default;
  const meta = await sharp(opts.buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('overlay_compose: unreadable image');
  const all = `${title}\n${subtitle}`;
  const skipped = [...new Set([...all].filter(c => !/\s/.test(c) && !fontFor(fonts, c)))];
  const keep = (t: string) => skipped.length ? [...t].filter(c => !skipped.includes(c)).join('') : t;
  const maxWidth = width * 0.84;
  const maxBlockHeight = height * 0.46;
  const minSize = Math.round(width * 0.03);
  let size = Math.round(width * (opts.slideIndex === 0 ? 0.11 : 0.095));
  const fit = (s: number) => {
    const sub = Math.max(minSize, Math.round(s * SUBTITLE_SCALE));
    return { size: s, sub, top: wrap(fonts, keep(title), s, maxWidth), bottom: wrap(fonts, keep(subtitle), sub, maxWidth) };
  };
  let f = fit(size);
  const tooBig = (x: typeof f) => x.top.length + x.bottom.length > MAX_LINES
    || (x.top.length * x.size + x.bottom.length * x.sub) * LINE_HEIGHT > maxBlockHeight
    || x.top.some(l => advance(fonts, l, x.size) > maxWidth) || x.bottom.some(l => advance(fonts, l, x.sub) > maxWidth);
  while (size > minSize && tooBig(f)) { size = Math.max(minSize, size - 2); f = fit(size); }
  const rows = [...f.top.map(line => ({ line, size: f.size })), ...f.bottom.map(line => ({ line, size: f.sub }))];
  const blockHeight = rows.reduce((h, r) => h + r.size * LINE_HEIGHT, 0);
  const centre = height * (opts.slideIndex === 0 ? 0.5 : 0.2);
  let y = Math.min(Math.max(centre - blockHeight / 2, height * 0.1), height * 0.8 - blockHeight);
  const paths: Array<{ d: string; size: number }> = [];
  for (const r of rows) {
    let x = (width - advance(fonts, r.line, r.size)) / 2;
    const baseline = y + r.size;
    const parts: string[] = [];
    for (const char of r.line) {
      const font = fontFor(fonts, char);
      if (!font) continue;
      if (char.trim()) parts.push(font.getPath(char, x, baseline, r.size).toPathData(2));
      x += font.getAdvanceWidth(char, r.size);
    }
    paths.push({ d: parts.join(' '), size: r.size });
    y += r.size * LINE_HEIGHT;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + paths.map(p => `<path d="${p.d}" fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="${(p.size * 0.16).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"/>`).join('')
    + paths.map(p => `<path d="${p.d}" fill="#fff"/>`).join('') + '</svg>';
  const buffer = await sharp(opts.buffer).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { buffer, contentType: 'image/jpeg', font: OVERLAY_FONT_NAME, fontSize: f.size, lines: rows.map(r => r.line), skipped };
}
