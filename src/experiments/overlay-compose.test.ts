import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { composeOverlay } from './overlay-compose.js';
import { Instructions, InstructionsInput } from './schema.js';

const frame = (w = 540, h = 960) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 80, b: 120 } } }).jpeg().toBuffer();
async function lightPixels(buffer: Buffer, from: number, to: number) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let light = 0;
  for (let y = Math.floor(info.height * from); y < Math.floor(info.height * to); y++) {
    for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * info.channels]! > 230) light++;
  }
  return light;
}

describe('composeOverlay (SLA-787)', () => {
  test('empty text returns the original bytes untouched', async () => {
    const buffer = await frame();
    const out = await composeOverlay({ buffer, text: '   ', slideIndex: 0 });
    expect(out.buffer).toBe(buffer);
    expect(out.lines).toEqual([]);
  });

  test('draws white text on the frame and keeps its dimensions', async () => {
    const buffer = await frame();
    const out = await composeOverlay({ buffer, text: 'Take a break today', slideIndex: 0 });
    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([540, 960, 'jpeg']);
    expect(await lightPixels(out.buffer, 0.3, 0.7)).toBeGreaterThan(500);
    expect(await lightPixels(buffer, 0.3, 0.7)).toBe(0);
    expect(out.font).toBe('Inter Bold');
  });

  test('the hook is centred, later slides sit in the upper third', async () => {
    const buffer = await frame();
    const hook = await composeOverlay({ buffer, text: 'Short line', slideIndex: 0 });
    const body = await composeOverlay({ buffer, text: 'Short line', slideIndex: 2 });
    expect(await lightPixels(hook.buffer, 0.4, 0.6)).toBeGreaterThan(200);
    expect(await lightPixels(hook.buffer, 0.1, 0.35)).toBe(0);
    expect(await lightPixels(body.buffer, 0.1, 0.4)).toBeGreaterThan(200);
    expect(await lightPixels(body.buffer, 0.55, 0.95)).toBe(0);
  });

  test('long copy wraps and shrinks to fit inside the safe width', async () => {
    const buffer = await frame();
    const long = 'This is a very long overlay headline that has to wrap over several lines and still fit comfortably';
    const out = await composeOverlay({ buffer, text: long, slideIndex: 1 });
    expect(out.lines.length).toBeGreaterThan(1);
    expect(out.lines.join(' ')).toBe(long);
    expect(await lightPixels(out.buffer, 0, 0.06)).toBe(0);
    expect(await lightPixels(out.buffer, 0.85, 1)).toBe(0);
  });

  test('Latin-extended and Cyrillic render; uncovered glyphs are reported, not drawn', async () => {
    const out = await composeOverlay({ buffer: await frame(), text: 'Привет café 😀', slideIndex: 0 });
    expect(out.skipped).toEqual(['😀']);
    expect(out.lines.join(' ')).toBe('Привет café');
  });

  test('an unreadable image fails loudly', async () => {
    await expect(composeOverlay({ buffer: Buffer.from('nope'), text: 'x y', slideIndex: 0 })).rejects.toThrow();
  });
});

describe('overlayMode schema (SLA-787)', () => {
  const base = { goal: 'g', brand: '', audience: '', language: 'English', direction: 'd', lockedConstraints: [], variables: ['hook'], mode: 'controlled' };
  test('is optional and accepts only model or script', () => {
    expect(Instructions.parse(base).overlayMode).toBeUndefined();
    expect(Instructions.parse({ ...base, overlayMode: 'script' }).overlayMode).toBe('script');
    expect(Instructions.parse({ ...base, overlayMode: 'model' }).overlayMode).toBe('model');
    expect(Instructions.safeParse({ ...base, overlayMode: 'auto' }).success).toBe(false);
    expect(InstructionsInput.safeParse({ ...base, overlayMode: 'script' }).success).toBe(true);
  });
});
