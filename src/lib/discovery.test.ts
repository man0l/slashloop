import { describe, expect, test } from 'bun:test';
import { aggregateDiscovery, extractHashtags, median, parseDiscoveryInput, type SeedMineResult } from './discovery.js';

describe('extractHashtags', () => {
  test('lowercases and dedupes within a caption', () => {
    expect(extractHashtags('love #Sauna life #sauna #SAUNA')).toEqual(['sauna']);
  });

  test('keeps unicode tags and underscores', () => {
    expect(extractHashtags('#Ünicode #gym_tok #планк')).toEqual(['ünicode', 'gym_tok', 'планк']);
  });

  test('no tags, no noise', () => {
    expect(extractHashtags('plain caption, nothing to mine')).toEqual([]);
    expect(extractHashtags('hash # without tag chars')).toEqual([]);
  });
});

describe('median', () => {
  test('odd count picks the middle', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test('even count rounds the midpoint', () => {
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  test('empty is zero', () => {
    expect(median([])).toBe(0);
  });
});

describe('parseDiscoveryInput', () => {
  test('classifies by prefix and normalizes', () => {
    expect(parseDiscoveryInput(['@Coach', '#GymTok', 'home workout'])).toEqual([
      { sourceType: 'creator', query: 'coach', rationale: 'Typed by the user.', origin: 'input' },
      { sourceType: 'hashtag', query: 'gymtok', rationale: 'Typed by the user.', origin: 'input' },
      { sourceType: 'keyword', query: 'home workout', rationale: 'Typed by the user.', origin: 'input' },
    ]);
  });

  test('dedupes the same target typed twice', () => {
    const seeds = parseDiscoveryInput(['#sauna', 'sauna', '@coach', '@Coach']);
    expect(seeds).toHaveLength(3); // #sauna + keyword sauna stay distinct; @coach collapses
  });

  test('caps and drops empties', () => {
    expect(parseDiscoveryInput(['', '   ', ...Array.from({ length: 12 }, (_, i) => `term${i}`)])).toHaveLength(8);
  });
});

function mine(partial: Partial<SeedMineResult> & { seed: SeedMineResult['seed'] }): SeedMineResult {
  return {
    ok: true, verified: true, sampleCount: 5, topViews: 0,
    hashtags: [], creators: [], creditsCharged: 8, creditsRemaining: 100,
    ...partial,
  };
}

describe('aggregateDiscovery', () => {
  const seedA = { sourceType: 'hashtag' as const, query: 'sauna', rationale: '', origin: 'input' as const };
  const seedB = { sourceType: 'keyword' as const, query: 'cold plunge', rationale: '', origin: 'ai' as const };

  test('merges hashtag counts across seeds, ranks by frequency, keeps strongest caption', () => {
    const result = aggregateDiscovery([
      mine({ seed: seedA, hashtags: [
        { query: 'fittok', videoCount: 3, avgViews: 1000, sampleCaption: 'a' },
        { query: 'gymtok', videoCount: 3, avgViews: 900, sampleCaption: 'g' },
      ] }),
      mine({ seed: seedB, hashtags: [
        { query: 'fittok', videoCount: 2, avgViews: 5000, sampleCaption: 'b' },
      ] }),
    ], new Set());

    expect(result.totalSampled).toBe(10);
    expect(result.hashtags[0]).toMatchObject({ query: 'fittok', videoCount: 5, avgViews: 2600, sampleCaption: 'b' });
    expect(result.hashtags[1].query).toBe('gymtok');
  });

  test('drops tags that ARE a probed seed, or tracked/dismissed', () => {
    const result = aggregateDiscovery([
      mine({ seed: seedA, hashtags: [
        { query: 'sauna', videoCount: 4, avgViews: 100, sampleCaption: '' },      // the seed itself
        { query: 'trackedtag', videoCount: 4, avgViews: 100, sampleCaption: '' }, // excludedKeys
        { query: 'keepme', videoCount: 1, avgViews: 100, sampleCaption: '' },
      ] }),
    ], new Set(['hashtag:trackedtag']));

    expect(result.hashtags.map(h => h.query)).toEqual(['keepme']);
  });

  test('merges creators across seeds and ranks by median views', () => {
    const result = aggregateDiscovery([
      mine({ seed: seedA, creators: [
        { query: 'coach', videoCount: 2, medianViews: 10_000, followers: 1000, sampleCaption: 'x' },
      ] }),
      mine({ seed: seedB, creators: [
        { query: 'coach', videoCount: 2, medianViews: 50_000, followers: null, sampleCaption: '' },
        { query: 'quiet', videoCount: 2, medianViews: 500, followers: 9, sampleCaption: '' },
      ] }),
    ], new Set());

    // Median of the two seed-level medians ([10k, 50k] → 30k): the aggregate
    // can't reconstruct per-video views, and a midpoint dampens one seed's
    // viral skew better than a max would.
    expect(result.creators[0]).toMatchObject({ query: 'coach', videoCount: 4, medianViews: 30_000, followers: 1000 });
    expect(result.creators[1].query).toBe('quiet');
  });

  test('excludes tracked creators and unverified seeds entirely', () => {
    const result = aggregateDiscovery([
      mine({ seed: seedA, verified: false, hashtags: [{ query: 'ghost', videoCount: 5, avgViews: 9, sampleCaption: '' }], creators: [] }),
      mine({ seed: seedB, creators: [{ query: 'trackedcoach', videoCount: 2, medianViews: 9, followers: null, sampleCaption: '' }] }),
    ], new Set(['creator:trackedcoach']));

    expect(result.hashtags).toEqual([]);
    expect(result.creators).toEqual([]);
    expect(result.totalSampled).toBe(5); // only the verified seed counts
  });
});
