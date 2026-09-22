import { describe, expect, test } from 'bun:test';
import { buildVariantSlidePrompt, effectiveOverlayText, visualLockForChanges, renderContract, identitySubject, lockCarouselIdentity, styleContract } from './render-prompt.js';
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

  test('middle slide keeps its overlay and final slide keeps its own payoff overlay', () => {
    expect(effectiveOverlayText(baseline, 1)).toBe('Make room for focus');
    // The last slide's overlayText is the story's payoff beat ("average
    // european", "day 30", …) — story copy, not a CTA. It renders verbatim.
    expect(effectiveOverlayText(baseline, 2)).toBe('Old closing headline');
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
    const prompt = buildVariantSlidePrompt(variant, 0, { language: 'English', brand: 'Studio', audience: 'Artists', direction: 'Keep the same teenager', unlocked: ['hook'], styleFormula: { medium: 'photograph', density: 'minimal' } }, 'hook-text');
    expect(prompt.toLowerCase()).toContain('same face');
    expect(prompt).toContain('same person');
    expect(prompt).toContain(variant.hook);
    expect(prompt).not.toContain('NEW original');
    const characterPrompt = buildVariantSlidePrompt(variant, 0, { language: 'English', brand: '', audience: '', direction: 'A 19-year-old with a taper fade', unlocked: ['character'], styleFormula: { medium: 'photograph', density: 'minimal' } }, 'character');
    expect(characterPrompt).toContain('Do not keep the baseline');
    expect(characterPrompt).toContain('taper fade');
  });

  test('non-edit locks must erase source text, never preserve it', () => {
    const ctx = { language: 'English', brand: '', audience: '' };
    const characterPrompt = buildVariantSlidePrompt(
      { ...baseline, character: 'A fitness coach holding a phone' },
      1, { ...ctx, unlocked: ['character'] }, 'character');
    expect(characterPrompt).toContain('erase EVERY word');
    expect(characterPrompt).toContain('Do not copy any text');
    const stylePrompt = buildVariantSlidePrompt(
      { ...baseline, visualStyle: 'Neon infographic' },
      1, { ...ctx, unlocked: ['visualStyle'] }, 'visualStyle');
    expect(stylePrompt).toContain('erase EVERY word');
    expect(stylePrompt).toContain('must be gone');
  });

  test('collage and drawing sources lock medium, not a photoreal face', () => {    expect(identitySubject({ medium: 'collage', density: 'rich' })).toBe('collage');
    expect(identitySubject({ medium: 'caricature', density: 'moderate' })).toBe('drawn-character');
    expect(identitySubject({ medium: 'photograph', density: 'minimal' })).toBe('person');
    const collage = styleContract({ medium: 'collage', density: 'rich' });
    expect(collage).toContain('COLLAGE');
    expect(collage.toLowerCase()).not.toContain('one subject composition');
    const locked = lockCarouselIdentity(baseline, { medium: 'collage', density: 'rich' });
    expect(locked.slides[1]!.scene).toContain('collage grammar');
    expect(locked.slides[1]!.scene).not.toContain('same person as slide 1');
    const prompt = buildVariantSlidePrompt(baseline, 0, { language: 'English', brand: '', audience: '', styleFormula: { medium: 'collage', density: 'rich' }, unlocked: ['hook'] }, 'hook-text');
    expect(prompt).toContain('collage grammar');
    expect(prompt.toLowerCase()).not.toContain('same face');
  });
});
