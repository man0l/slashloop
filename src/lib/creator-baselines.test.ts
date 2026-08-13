import { describe, expect, test } from 'bun:test';
import {
  needsCreatorHistory, creatorsNeedingHistory, CREATOR_HISTORY_EXTRA,
} from './creator-baselines.js';
import { CREATOR_BASELINE_MIN_SAMPLE } from '../scoring.js';

describe('needsCreatorHistory', () => {
  test('one hashtag hit is not enough for an actual score', () => {
    expect(needsCreatorHistory(1)).toBe(true);
    expect(needsCreatorHistory(0)).toBe(true);
    expect(needsCreatorHistory(CREATOR_BASELINE_MIN_SAMPLE - 1)).toBe(true);
  });

  test('at the sample floor we already have an actual baseline', () => {
    expect(needsCreatorHistory(CREATOR_BASELINE_MIN_SAMPLE)).toBe(false);
    expect(needsCreatorHistory(11)).toBe(false);
  });

  test('we pull 5 extra videos for a lone hashtag hit', () => {
    expect(CREATOR_HISTORY_EXTRA).toBe(5);
  });
});

describe('creatorsNeedingHistory', () => {
  test('keeps only thin-history creators', () => {
    const out = creatorsNeedingHistory([
      { handle: 'jaredrhod', platform: 'tiktok', held: 1 },
      { handle: 'plenty', platform: 'tiktok', held: 8 },
      { handle: 'four', platform: 'tiktok', held: 4 },
    ]);
    expect(out.map(c => c.handle)).toEqual(['jaredrhod', 'four']);
  });
});
