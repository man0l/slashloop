import { afterEach, describe, expect, test } from 'bun:test';
import {
  REFRESH_BATCH_PEER_CAP_DEFAULT,
  refreshBatchPeerCap,
  refreshBatchingEnabled,
  refreshCoalesceMs,
} from './jobs.js';
import { canonicalKey, normalizeQuery } from './canonical-query.js';

const ENV_KEYS = ['REFRESH_BATCH_PEER_CAP', 'REFRESH_BATCHING_ENABLED', 'REFRESH_COALESCE_MS'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('batching kill switch and caps', () => {
  test('batching is on by default and only "0" disables it', () => {
    expect(refreshBatchingEnabled()).toBe(true);
    process.env.REFRESH_BATCHING_ENABLED = '0';
    expect(refreshBatchingEnabled()).toBe(false);
    process.env.REFRESH_BATCHING_ENABLED = '1';
    expect(refreshBatchingEnabled()).toBe(true);
  });

  test('peer cap is overridable and rejects junk', () => {
    expect(refreshBatchPeerCap()).toBe(REFRESH_BATCH_PEER_CAP_DEFAULT);
    process.env.REFRESH_BATCH_PEER_CAP = '3';
    expect(refreshBatchPeerCap()).toBe(3);
    // 0 is meaningful: batch nothing, one scrape per job.
    process.env.REFRESH_BATCH_PEER_CAP = '0';
    expect(refreshBatchPeerCap()).toBe(0);
    process.env.REFRESH_BATCH_PEER_CAP = 'nonsense';
    expect(refreshBatchPeerCap()).toBe(REFRESH_BATCH_PEER_CAP_DEFAULT);
    process.env.REFRESH_BATCH_PEER_CAP = '-2';
    expect(refreshBatchPeerCap()).toBe(REFRESH_BATCH_PEER_CAP_DEFAULT);
  });

  test('coalescing hold defaults to a real window and 0 disables it', () => {
    // A zero default would mean the worker claims each refresh alone and
    // batching never fires — the whole point of the hold.
    expect(refreshCoalesceMs()).toBeGreaterThan(0);
    process.env.REFRESH_COALESCE_MS = '0';
    expect(refreshCoalesceMs()).toBe(0);
    process.env.REFRESH_COALESCE_MS = '5000';
    expect(refreshCoalesceMs()).toBe(5000);
    process.env.REFRESH_COALESCE_MS = 'later';
    expect(refreshCoalesceMs()).toBeGreaterThan(0);
  });

  test('disabling batching also drops the hold — no latency for no benefit', () => {
    process.env.REFRESH_COALESCE_MS = '30000';
    process.env.REFRESH_BATCHING_ENABLED = '0';
    expect(refreshCoalesceMs()).toBe(0);
  });
});

describe('canonical grouping — what shares one Apify run', () => {
  test('the same creator written differently is one key', () => {
    const a = canonicalKey('tiktok', 'creator', '@BuildingWithLiz_');
    const b = canonicalKey('tiktok', 'creator', 'buildingwithliz_');
    const c = canonicalKey('TikTok', 'creator', '  @@buildingwithliz_  ');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('different platform, type or query never share a scrape', () => {
    const creator = canonicalKey('tiktok', 'creator', 'foo');
    expect(canonicalKey('reels', 'creator', 'foo')).not.toBe(creator);
    expect(canonicalKey('tiktok', 'hashtag', 'foo')).not.toBe(creator);
    expect(canonicalKey('tiktok', 'creator', 'bar')).not.toBe(creator);
  });

  test('a hashtag keeps its # stripped, a keyword keeps its text', () => {
    expect(normalizeQuery('hashtag', '#BuildInPublic')).toBe('buildinpublic');
    expect(normalizeQuery('keyword', 'Build In Public')).toBe('build in public');
  });
});
