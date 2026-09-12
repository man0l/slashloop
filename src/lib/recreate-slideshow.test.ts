import { describe, expect, test } from 'bun:test';
import {
  buildRecreateSlidePrompt,
  buildVideoSlidePrompt,
  normalizeSlidePlan,
  fallbackIntervalPlan,
  planTimestamps,
  MAX_VIDEO_SLIDES,
  MIN_VIDEO_SLIDES,
} from './recreate-slideshow.js';

describe('buildRecreateSlidePrompt', () => {
  test('asks for a 9:16 restage and keeps overlay text', () => {
    const prompt = buildRecreateSlidePrompt({
      slideIndex: 2,
      slideCount: 6,
      caption: 'Ratings with @PSL App',
      description: 'Face on black with overlay',
      onScreenText: '3 - MODERATE STRESS LEVELS',
    });
    expect(prompt).toContain('slide 3 of 6');
    expect(prompt).toContain('9:16');
    expect(prompt).toContain('3 - MODERATE STRESS LEVELS');
    expect(prompt).toContain('Face on black with overlay');
    expect(prompt).toContain('No TikTok UI');
  });
});

describe('buildVideoSlidePrompt', () => {
  test('demands overlay removal — the opposite of the photo prompt', () => {
    const prompt = buildVideoSlidePrompt({
      slideIndex: 0,
      slideCount: 4,
      caption: 'Official PSL ratings with @PSL App',
      description: 'Headshot with a modern fade',
    });
    expect(prompt).toContain('9:16');
    expect(prompt).toContain('slide 1 of 4');
    expect(prompt).toContain('Headshot with a modern fade');
    expect(prompt).toContain('Remove every trace of burned-in text');
    expect(prompt).toContain('play buttons');
    expect(prompt).toContain('watermarks');
    expect(prompt).not.toContain('Keep this on-screen text');
  });

  test('omits empty scene briefs', () => {
    const prompt = buildVideoSlidePrompt({ slideIndex: 0, slideCount: 3, caption: 'c', description: '' });
    expect(prompt).not.toContain('Scene:');
  });
});

describe('normalizeSlidePlan', () => {
  test('sorts, clamps to duration, drops near-duplicate timestamps and caps the deck', () => {
    const plan = normalizeSlidePlan(
      { slides: [
        { tSec: 8, description: 'c' },
        { tSec: 2, description: 'a' },
        { tSec: 2.9, description: 'near-dup of a' },
        { tSec: 500, description: 'past the end' },
        ...Array.from({ length: 8 }, (_, i) => ({ tSec: 20 + i * 3, description: `s${i}` })),
      ] },
      60,
    );
    expect(plan.slides[0].tSec).toBe(2);
    // 500 clamps to 60 - 0.3; the 59.7 drop is also dropped as a duplicate of
    // nothing, but the cap keeps the deck at MAX.
    expect(plan.slides.every(s => s.tSec <= 59.7)).toBe(true);
    expect(plan.slides.length).toBeLessThanOrEqual(MAX_VIDEO_SLIDES);
    for (let i = 1; i < plan.slides.length; i++) {
      expect(plan.slides[i].tSec - plan.slides[i - 1].tSec).toBeGreaterThanOrEqual(2);
    }
  });

  test('throws on unusable output', () => {
    expect(() => normalizeSlidePlan({ slides: [] }, 30)).toThrow();
    expect(() => normalizeSlidePlan({ nope: true }, 30)).toThrow();
  });
});

describe('fallbackIntervalPlan', () => {
  test('spreads evenly and respects null duration', () => {
    expect(fallbackIntervalPlan(30, 6).slides.map(s => s.tSec)).toEqual([2.5, 7.5, 12.5, 17.5, 22.5, 27.5]);
    expect(fallbackIntervalPlan(null, 4).slides).toHaveLength(4);
  });
});

describe('planTimestamps', () => {
  test('tops up short plans to a carousel-worthy count without near-duplicates', () => {
    const ts = planTimestamps({ slides: [{ tSec: 1, description: 'only', overlayText: null }] }, 10);
    expect(ts.length).toBeGreaterThanOrEqual(MIN_VIDEO_SLIDES);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(2);
  });

  test('leaves healthy plans untouched', () => {
    const ts = planTimestamps({ slides: [
      { tSec: 2, description: 'a', overlayText: null },
      { tSec: 5, description: 'b', overlayText: null },
      { tSec: 9, description: 'c', overlayText: null },
    ] }, 12);
    expect(ts).toEqual([2, 5, 9]);
  });
});
