import { describe, expect, test } from 'bun:test';
import {
  aggregateDiscovery, extractHashtags, median, mineFromItems, mineResultFromDiscoverJob,
  parseDiscoveryInput, shouldQueueDiscoverMine, type SeedMineResult,
} from './discovery.js';
import type { NormalizedVideo } from '../normalizers.js';

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

function video(over: Partial<NormalizedVideo> = {}): NormalizedVideo {
  return {
    platform: 'tiktok', externalId: '1', url: 'https://tiktok.com/x',
    thumbnailUrl: '', coverDownloadUrl: null, creatorHandle: 'alice',
    creatorFollowers: 1000, caption: 'study #studytok #notes', postedAt: '',
    views: 1000, likes: 0, comments: 0, shares: null, saves: null,
    durationSec: 10, transcript: null, transcriptSource: 'none', sound: null, raw: {},
    ...over,
  };
}

describe('shouldQueueDiscoverMine', () => {
  const keys = ['WORKER_KINDS', 'WORKER_URL', 'WORKER_ACTIVE'] as const;
  const saved: Record<string, string | undefined> = {};
  function setEnv(over: Partial<Record<(typeof keys)[number], string | undefined>>) {
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) {
      if (over[k] === undefined) delete process.env[k];
      else process.env[k] = over[k];
    }
  }
  function restore() {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test('queues on Vercel (WORKER_URL set, no scraper kinds)', () => {
    setEnv({ WORKER_URL: 'https://mcp.slashloop.dev', WORKER_KINDS: undefined, WORKER_ACTIVE: undefined });
    try { expect(shouldQueueDiscoverMine()).toBe(true); } finally { restore(); }
  });

  test('does not queue on the scraper worker (would deadlock)', () => {
    setEnv({ WORKER_URL: 'https://mcp.slashloop.dev', WORKER_KINDS: 'refresh,thumb,discover' });
    try { expect(shouldQueueDiscoverMine()).toBe(false); } finally { restore(); }
  });

  test('scrapes inline locally (no WORKER_URL)', () => {
    setEnv({ WORKER_URL: undefined, WORKER_KINDS: undefined, WORKER_ACTIVE: undefined });
    try { expect(shouldQueueDiscoverMine()).toBe(false); } finally { restore(); }
  });
});

describe('mineResultFromDiscoverJob', () => {
  const seed = { sourceType: 'hashtag' as const, query: 'sauna', rationale: '', origin: 'input' as const };

  test('queued and running stay pending', () => {
    for (const status of ['queued', 'running'] as const) {
      const result = mineResultFromDiscoverJob(seed, {
        id: 'job-1', status, payloadJson: '{}', lastError: null,
      }, 90);
      expect(result).toMatchObject({ ok: true, pending: true, jobId: 'job-1', verified: false });
    }
  });

  test('done with a stored mine result returns it', () => {
    const stored = {
      ok: true, verified: true, sampleCount: 5, topViews: 1000,
      hashtags: [{ query: 'notes', videoCount: 2, avgViews: 100, sampleCaption: '' }],
      creators: [], sounds: [], creditsCharged: 8, creditsRemaining: 82,
    };
    const result = mineResultFromDiscoverJob(seed, {
      id: 'job-2', status: 'done',
      payloadJson: JSON.stringify({ sourceType: 'hashtag', query: 'sauna', result: stored }),
      lastError: null,
    }, 82);
    expect(result).toMatchObject({ ok: true, verified: true, sampleCount: 5, jobId: 'job-2', creditsCharged: 8 });
    expect(result.hashtags[0].query).toBe('notes');
  });

  test('failed surfaces the scraper error', () => {
    const result = mineResultFromDiscoverJob(seed, {
      id: 'job-3', status: 'failed', payloadJson: '{}', lastError: 'TLS reset',
    }, 90);
    expect(result).toMatchObject({ ok: false, jobId: 'job-3', error: 'TLS reset' });
  });
});

describe('mineFromItems', () => {
  const seed = { sourceType: 'hashtag' as const, query: 'studytok', rationale: '', origin: 'input' as const };

  test('empty sample is unverified', () => {
    expect(mineFromItems(seed, [])).toMatchObject({ verified: false, sampleCount: 0, hashtags: [], creators: [] });
  });

  test('mines other hashtags and drops the seed tag', () => {
    const mined = mineFromItems(seed, [
      video({ caption: '#studytok #notes', views: 2000, creatorHandle: 'alice' }),
      video({ caption: '#studytok #notes', views: 500, creatorHandle: 'alice' }),
      video({ caption: '#pomodoro', views: 100, creatorHandle: 'bob' }),
    ]);
    expect(mined.verified).toBe(true);
    expect(mined.sampleCount).toBe(3);
    expect(mined.topViews).toBe(2000);
    expect(mined.hashtags.map(h => h.query)).toEqual(['notes', 'pomodoro']);
    expect(mined.creators).toEqual([
      expect.objectContaining({ query: 'alice', videoCount: 2, medianViews: 1250 }),
    ]);
  });

  test('aggregates TikTok sounds from the sample', () => {
    const mined = mineFromItems(seed, [
      video({ views: 2000, sound: { id: 's1', title: 'original sound', author: 'alice' } }),
      video({ views: 500, sound: { id: 's1', title: 'original sound', author: 'alice' } }),
      video({ views: 100, sound: { id: 's2', title: 'trend', author: 'bob' } }),
    ]);
    expect(mined.sounds[0]).toMatchObject({ query: 's1', title: 'original sound', videoCount: 2, avgViews: 1250 });
    expect(mined.sounds.map(s => s.query)).toEqual(['s1', 's2']);
  });
});

function mine(partial: Partial<SeedMineResult> & { seed: SeedMineResult['seed'] }): SeedMineResult {
  return {
    ok: true, verified: true, sampleCount: 5, topViews: 0,
    hashtags: [], creators: [], sounds: [], creditsCharged: 8, creditsRemaining: 100,
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
