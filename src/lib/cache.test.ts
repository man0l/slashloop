import { describe, expect, test } from 'bun:test';
import { cacheKey, cacheSize, clearCache, getOrFill, invalidateCache } from './cache.js';

describe('cacheKey', () => {
  test('joins parts stably and keeps workspaces distinct', () => {
    expect(cacheKey(['sources', 'ws-1', 'tiktok'])).toBe('sources|ws-1|tiktok');
    expect(cacheKey(['sources', 'ws-1'])).not.toBe(cacheKey(['sources', 'ws-2']));
  });
});

describe('getOrFill', () => {
  test('caches within TTL and refills after expiry', async () => {
    clearCache();
    let fills = 0;
    const fill = async () => (++fills, { n: fills });
    expect(await getOrFill('k1', 50, fill)).toEqual({ n: 1 });
    expect(await getOrFill('k1', 50, fill)).toEqual({ n: 1 });
    expect(fills).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    expect(await getOrFill('k1', 50, fill)).toEqual({ n: 2 });
    expect(fills).toBe(2);
  });

  test('concurrent identical calls share one fill (singleflight)', async () => {
    clearCache();
    let fills = 0;
    const fill = async () => {
      fills++;
      await new Promise((r) => setTimeout(r, 30));
      return 'v';
    };
    const results = await Promise.all([
      getOrFill('k2', 1000, fill),
      getOrFill('k2', 1000, fill),
      getOrFill('k2', 1000, fill),
    ]);
    expect(results).toEqual(['v', 'v', 'v']);
    expect(fills).toBe(1);
  });

  test('fill errors propagate and are not cached', async () => {
    clearCache();
    let calls = 0;
    const fail = async (): Promise<string> => {
      calls++;
      throw new Error('db down');
    };
    await expect(getOrFill('k3', 1000, fail)).rejects.toThrow('db down');
    await expect(getOrFill('k3', 1000, fail)).rejects.toThrow('db down');
    expect(calls).toBe(2);
  });

  test('a failed fill does not block later callers', async () => {
    clearCache();
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('once');
      return 'ok';
    };
    await expect(getOrFill('k4', 1000, flaky)).rejects.toThrow('once');
    expect(await getOrFill('k4', 1000, flaky)).toBe('ok');
  });
});

describe('invalidateCache', () => {
  test('drops by prefix, keeps neighbours', async () => {
    clearCache();
    await getOrFill('sources|ws-1', 60_000, async () => 'a');
    await getOrFill('sources|ws-2', 60_000, async () => 'b');
    expect(invalidateCache('sources|ws-1')).toBe(1);
    expect(cacheSize()).toBe(1);
  });
});

describe('bounds', () => {
  test('entry count stays capped', async () => {
    clearCache();
    for (let i = 0; i < 250; i++) {
      await getOrFill(`k${i}`, 60_000, async () => i);
    }
    expect(cacheSize()).toBeLessThanOrEqual(100);
  });
});
