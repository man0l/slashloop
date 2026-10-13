import { describe, expect, test } from 'bun:test';
import { buildVariantSlidePrompt, redactOverlayCopy, REDACTED_COPY, compileSlideContract, effectiveOverlayText, labelPolicy, visualLockForChanges, renderContract, identitySubject, lockCarouselIdentity, styleContract } from './render-prompt.js';
import { slideFanout } from './schema.js';
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
    expect(renderContract(['character'], [{ name: 'character' }])).toMatchObject({ changeFaces: true, changeOverlay: false, fanout: slideFanout() });
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

  test('non-edit locks erase only what the label policy removes', () => {
    const ctx = { language: 'English', brand: '', audience: '' };
    // No compiled contract (legacy caller): the blanket erase rule still applies.
    const legacyCharacter = buildVariantSlidePrompt(
      { ...baseline, character: 'A fitness coach holding a phone' },
      1, { ...ctx, unlocked: ['character'] }, 'character');
    expect(legacyCharacter).toContain('erase EVERY word');
    expect(legacyCharacter).toContain('Do not copy any text');
    // With a contract, the D6 policy replaces the blanket erase: enumerated source
    // prop labels survive while platform marks are removed.
    const labels = labelPolicy(["preserve label: Nutella", 'keep the brand logo out']);
    expect(labels.preserve).toEqual(['Nutella']);
    const characterPrompt = buildVariantSlidePrompt(
      { ...baseline, character: 'A fitness coach holding a phone' },
      1, { ...ctx, unlocked: ['character'] }, 'character',
      compileSlideContract({
        slideIndex: 1, role: 'proof', medium: 'photograph', scene: baseline.slides[1]!.scene,
        overlay: { mode: 'preserve', text: baseline.slides[1]!.overlayText, origin: 'source' },
        observedCopy: { state: 'observed_text', text: baseline.slides[1]!.overlayText },
        sourceMap: { videoId: 'v', analysisId: 'a', sourceIndex: 1, referenceKind: 'slide', path: 'p' }, labels,
      }));
    expect(characterPrompt).toContain('SOURCE LABELS');
    expect(characterPrompt).toContain('Nutella');
    expect(characterPrompt).toContain('platform usernames');
    expect(characterPrompt).not.toContain('erase EVERY word');
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

describe('script overlay prompt (SLA-787)', () => {
  const context = { language: 'English', brand: 'Studio', audience: 'Artists', direction: 'Say "Make room for focus" in a bold headline' };
  test('redactOverlayCopy replaces verbatim, case-insensitive and JSON-escaped occurrences', () => {
    const out = redactOverlayCopy('say "Make  room for focus" or {\\"t\\":\\"say \\\\\\"hi\\\\\\" now\\"} MAKE ROOM FOR FOCUS', ['Make room for focus', 'say "hi" now', 'x']);
    expect(out).not.toMatch(/make\s+room/i);
    expect(out).toContain(REDACTED_COPY);
  });
  test('regex metacharacters in copy are matched literally', () => {
    expect(redactOverlayCopy('cost: $5 (50% off?) [now]', ['$5 (50% off?) [now]'])).toBe(`cost: ${REDACTED_COPY}`);
  });
  test('short or blank copy is never redacted', () => {
    expect(redactOverlayCopy('a b c', ['', ' ', 'a'])).toBe('a b c');
  });
  test('script mode drops the copy, the quoted direction and the copy-override carrier', () => {
    const variant = structuredClone(baseline);
    variant.copyOverrides = { '1': 'Make room for focus' };
    const prompt = buildVariantSlidePrompt(variant, 1, { ...context, scriptOverlay: { redact: ['Make room for focus', 'Try it today', 'A caption for the post'] } }, 'open');
    expect(prompt).not.toContain('Make room for focus');
    expect(prompt).toContain(REDACTED_COPY);
    expect(prompt).toContain('TEXT-FREE RENDER');
    expect(prompt).toContain('FINAL RULE: the image contains no added text at all.');
    expect(prompt).not.toContain('the only ADDED text');
  });
  test('a copy-only contract drops the free-text direction entirely', () => {
    const prompt = buildVariantSlidePrompt(baseline, 1, { ...context, scriptOverlay: { redact: [] } }, 'hook-text');
    expect(prompt).toContain('"creativeDirection":""');
    expect(prompt).not.toContain('bold headline');
  });
  test('without script mode the same brief still renders its copy', () => {
    const prompt = buildVariantSlidePrompt(baseline, 1, context, 'open');
    expect(prompt).toContain('Make room for focus');
    expect(prompt).not.toContain('TEXT-FREE RENDER');
  });
  test('script mode keeps the creative direction when it casts a new subject', () => {
    const prompt = buildVariantSlidePrompt(baseline, 1, { ...context, direction: 'a red-haired woman', scriptOverlay: { redact: [] } }, 'character');
    expect(prompt).toContain('a red-haired woman');
  });
});
