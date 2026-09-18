import { describe, expect, test } from 'bun:test';
import { buildVariantSlidePrompt, effectiveOverlayText, visualLockForChanges, renderContract } from './render-prompt.js';
import type { BriefData } from './schema.js';

const baseline: BriefData = {
  concept: 'A calmer morning', hook: 'Original opening headline', character: 'A ceramic artist',
  visualStyle: 'Warm editorial photography', caption: 'A caption for the post', cta: 'Try it today', lockedConstraints: [],
  slides: [
    { role: 'hook', scene: 'An artist opens the studio', overlayText: 'Original opening headline' },
    { role: 'proof', scene: 'Hands shaping a bowl', overlayText: 'Make room for focus' },
    { role: 'cta', scene: 'A finished bowl in sunlight', overlayText: 'Old closing headline' },
  ],
};

describe('variant slide rendering', () => {
  test('a changed hook replaces inherited slide text in the actual provider prompt', async () => {
    const variant = structuredClone(baseline);
    variant.hook = 'What if your morning felt like this?';
    expect(effectiveOverlayText(variant, 0)).toBe(variant.hook);
    const calls: string[] = [];
    const fakeImageProvider = async ({ prompt }: { prompt: string }) => {
      calls.push(prompt);
      return { bytes: new Uint8Array([1, 2, 3]) };
    };
    const prompt = buildVariantSlidePrompt(variant, 0, { language: 'English', brand: 'Studio', audience: 'Artists' });
    const result = await fakeImageProvider({ prompt });
    expect(result.bytes.length).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(variant.hook);
    expect(calls[0]).not.toContain(baseline.hook);
    expect(calls[0]).not.toContain(baseline.caption);
    expect(baseline.slides[0]!.overlayText).toBe('Original opening headline');
  });

  test('middle slide keeps its overlay and final slide uses the current CTA', () => {
    expect(effectiveOverlayText(baseline, 1)).toBe('Make room for focus');
    expect(effectiveOverlayText(baseline, 2)).toBe('Try it today');
    const variant = { ...baseline, cta: '' };
    expect(effectiveOverlayText(variant, 2)).toBe('Old closing headline');
  });

  test('rejects an out-of-range slide instead of rendering a guessed scene', () => {
    expect(() => effectiveOverlayText(baseline, 3)).toThrow(RangeError);
    expect(() => buildVariantSlidePrompt(baseline, -1, { language: 'English', brand: '', audience: '' })).toThrow(RangeError);
  });

  test('hook-only variants lock the picture and only swap overlay text', () => {
    expect(visualLockForChanges([])).toBe('open');
    expect(visualLockForChanges([{ name: 'hook' }])).toBe('hook-text');
    expect(visualLockForChanges([{ name: 'character' }])).toBe('character');
    expect(renderContract(['hook'], [{ name: 'hook' }])).toMatchObject({ changeFaces: false, changeOverlay: true, fanout: 1 });
    expect(renderContract(['character'], [{ name: 'character' }])).toMatchObject({ changeFaces: true, changeOverlay: false, fanout: 3 });
    const variant = { ...baseline, hook: 'What if your morning felt like this?' };
    const prompt = buildVariantSlidePrompt(variant, 0, { language: 'English', brand: 'Studio', audience: 'Artists', direction: 'Keep the same teenager', unlocked: ['hook'] }, 'hook-text');
    expect(prompt.toLowerCase()).toContain('same face');
    expect(prompt).toContain('same person');
    expect(prompt).toContain(variant.hook);
    expect(prompt).not.toContain('NEW original');
    const characterPrompt = buildVariantSlidePrompt(variant, 0, { language: 'English', brand: '', audience: '', direction: 'A 19-year-old with a taper fade', unlocked: ['character'] }, 'character');
    expect(characterPrompt).toContain('Do not keep the baseline');
    expect(characterPrompt).toContain('taper fade');
  });
});
