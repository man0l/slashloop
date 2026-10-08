import { expect, test } from 'bun:test';
import { videoStatsChanged, type StoredVideoStats } from './refresh.js';
import type { NormalizedVideo } from '../normalizers.js';

function stored(over: Partial<StoredVideoStats> = {}): StoredVideoStats {
  return {
    views: 1000, likes: 100, comments: 10, shares: 5, saves: 2,
    creatorFollowers: 5000, soundId: 's1', soundTitle: 't', soundAuthor: 'a',
    isBaselineSample: false,
    ...over,
  };
}

function scraped(): NormalizedVideo {
  return {
    platform: 'tiktok', externalId: 'v1', url: 'https://x', thumbnailUrl: 'https://t',
    creatorHandle: 'c', creatorFollowers: 5000, caption: '',
    postedAt: new Date().toISOString(), views: 1000, likes: 100, comments: 10,
    shares: 5, saves: 2, durationSec: 10, transcript: null, transcriptSource: 'none',
    sound: { id: 's1', title: 't', author: 'a' }, raw: {},
  };
}

test('identical stats report no change', () => {
  expect(videoStatsChanged(stored(), scraped(), false)).toBe(false);
});

test('any stat delta reports a change', () => {
  const nv = scraped();
  nv.views = 1001;
  expect(videoStatsChanged(stored(), nv, false)).toBe(true);
});

test('null shares/saves compare equal to null, not to zero-churn', () => {
  const nv = scraped();
  nv.shares = null;
  nv.saves = null;
  expect(videoStatsChanged(stored({ shares: null, saves: null }), nv, false)).toBe(false);
});

test('a missing scrape sound leaves stored sound columns alone (no change)', () => {
  const nv = scraped();
  nv.sound = null;
  expect(videoStatsChanged(stored(), nv, false)).toBe(false);
});

test('a changed scrape sound reports a change', () => {
  const nv = scraped();
  nv.sound = { id: 's2', title: 't', author: 'a' };
  expect(videoStatsChanged(stored(), nv, false)).toBe(true);
});

test('baseline-sample flag flip counts as a change outside baseline mode', () => {
  expect(videoStatsChanged(stored({ isBaselineSample: true }), scraped(), false)).toBe(true);
  expect(videoStatsChanged(stored({ isBaselineSample: true }), scraped(), true)).toBe(false);
});
