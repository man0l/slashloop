import { expect, test } from 'bun:test';
import { analysisHasCtaSlide, deriveStorySlideCount, overlayLooksLikeCta, storySlideCount } from './slide-count.js';

test('CTA overlay detector', () => {
  expect(overlayLooksLikeCta('Follow for more')).toBe(true);
  expect(overlayLooksLikeCta('Link in bio')).toBe(true);
  expect(overlayLooksLikeCta('Why steak hits different')).toBe(false);
  expect(overlayLooksLikeCta('')).toBe(false);
});

test('last-slide CTA from shots and beats', () => {
  const shots = [0, 1, 2, 3, 4].map(i => ({ timestampSec: i, description: `Slide ${i}`, onScreenText: i === 4 ? 'Follow for more' : 'A tip' }));
  expect(analysisHasCtaSlide({ shots }, 5)).toBe(true);
  expect(analysisHasCtaSlide({ shots: shots.map(s => ({ ...s, onScreenText: 'A tip' })), storytellingBeats: [{ type: 'cta', timestampSec: 4 }] }, 5)).toBe(true);
  expect(analysisHasCtaSlide({ shots: shots.map(s => ({ ...s, onScreenText: 'A tip' })) }, 5)).toBe(false);
});

test('story count is originals minus CTA, clamped 3–8', () => {
  expect(storySlideCount(6, true)).toBe(5);
  expect(storySlideCount(5, false)).toBe(5);
  expect(storySlideCount(3, true)).toBe(3);
  expect(storySlideCount(12, false)).toBe(8);
});

test('derive uses the smallest source story count', () => {
  expect(deriveStorySlideCount([
    { originalCount: 6, analysis: { shots: [{ timestampSec: 5, onScreenText: 'Follow for more' }] } },
    { originalCount: 5, analysis: null },
  ])).toBe(5);
  expect(deriveStorySlideCount([{ originalCount: null }])).toBe(null);
});
