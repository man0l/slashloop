// Tests for scrape resumption — the retry path that was re-buying data.
//
// Measured across 215 refresh jobs: 77 retried, 139 EXTRA actor runs, all
// re-purchasing datasets Apify still held. Two halves are tested here:
//   1. scrapeTikTok resumes from a dataset instead of starting a run
//   2. the receipt is only trusted when it is genuinely safe to trust
//
// Mocked fetch, stubbed spend-cap: no DB, no network.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const capCalls: Array<{ workspaceId: string; cents: number }> = [];
const spendCalls: Array<{ workspaceId: string; cents: number; activity: string }> = [];

// Spread the real module: bun's mock.module is process-global, so a partial
// stub here silently removes exports from every OTHER test file that imports
// spend-cap (it did — decodeApifyRefId vanished from apify-spend.test.ts).
// Only the two DB-touching functions are replaced.
const realSpendCap = await import('./spend-cap.js');

mock.module('./spend-cap.js', () => ({
  ...realSpendCap,
  assertApifyCap: async (workspaceId: string, cents: number) => { capCalls.push({ workspaceId, cents }); },
  recordApifySpend: async (workspaceId: string, cents: number, _ref: string | null, activity = 'source_scrape') => {
    spendCalls.push({ workspaceId, cents, activity });
  },
}));

const { scrapeTikTok } = await import('./apify.js');
const { readScrapeReceipt, withScrapeReceipt, SCRAPE_RECEIPT_TTL_MS } = await import('./jobs.js');

const REAL_FETCH = globalThis.fetch;
let calls: string[] = [];

function video(id: string) {
  return {
    id,
    text: 'caption',
    createTimeISO: new Date().toISOString(),
    authorMeta: { name: 'someone' },
    webVideoUrl: `https://www.tiktok.com/@someone/video/${id}`,
    playCount: 100, diggCount: 10, commentCount: 1, shareCount: 1,
  };
}

beforeEach(() => {
  process.env.APIFY_API_KEY = 'apify_test_key';
  calls = [];
  capCalls.length = 0;
  spendCalls.length = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/runs?')) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { id: 'RUN1', defaultDatasetId: 'DS1', status: 'SUCCEEDED', usageTotalUsd: 0.019 },
      }), { status: 201 }));
    }
    if (u.includes('/datasets/')) {
      return Promise.resolve(new Response(JSON.stringify([video('1'), video('2')]), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify([video('1')]), { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.APIFY_API_KEY;
  delete process.env.APIFY_RESUMABLE_RUNS;
});

const opts = {
  workspaceId: 'ws-1',
  sourceType: 'hashtag' as const,
  query: 'vibecoding',
  limit: 5,
};

describe('scrapeTikTok — a run we can come back to', () => {
  test('a normal scrape hands back the receipt needed to resume it', async () => {
    const res = await scrapeTikTok(opts);
    expect(res.actorRunId).toBe('RUN1');
    expect(res.datasetId).toBe('DS1');
    expect(res.resumed).toBe(false);
    expect(res.items.length).toBe(2);
  });

  test('resuming reads the dataset and starts NO actor run', async () => {
    const res = await scrapeTikTok({ ...opts, resumeDatasetId: 'DS1' });
    expect(res.resumed).toBe(true);
    expect(res.items.length).toBe(2);
    expect(calls.some(u => u.includes('/runs?'))).toBe(false);
    expect(calls.every(u => u.includes('/datasets/'))).toBe(true);
  });

  test('a resumed scrape costs nothing and is not recorded as spend', async () => {
    const res = await scrapeTikTok({ ...opts, resumeDatasetId: 'DS1' });
    expect(res.costCents).toBe(0);
    expect(spendCalls).toHaveLength(0);
  });

  test('a resumed scrape does not consume spend-cap headroom', async () => {
    // No new money is being spent, so there is nothing to pre-authorise —
    // and a breached cap must not block re-reading data already bought.
    await scrapeTikTok({ ...opts, resumeDatasetId: 'DS1' });
    expect(capCalls).toHaveLength(0);
  });

  test('an unreadable receipt falls back to scraping rather than failing', async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      // Only the EXPIRED dataset is gone; the fresh run's dataset reads fine.
      if (u.includes('/datasets/EXPIRED')) return Promise.resolve(new Response('gone', { status: 404 }));
      if (u.includes('/datasets/')) return Promise.resolve(new Response(JSON.stringify([video('9')]), { status: 200 }));
      if (u.includes('/runs?')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: { id: 'RUN2', defaultDatasetId: 'DS2', status: 'SUCCEEDED' },
        }), { status: 201 }));
      }
      return Promise.resolve(new Response(JSON.stringify([video('9')]), { status: 200 }));
    }) as typeof fetch;

    const res = await scrapeTikTok({ ...opts, resumeDatasetId: 'EXPIRED' });
    expect(res.resumed).toBe(false);
    expect(res.datasetId).toBe('DS2');
    expect(res.costCents).toBeGreaterThan(0);
  });

  test("Apify's own billed figure wins over our model when reported", async () => {
    // usageTotalUsd 0.019 -> 2c, and our 5-result model would say 2c too, so
    // assert the plumbing rather than a coincidence: a cheap run must not be
    // recorded at the conservative free-tier estimate.
    globalThis.fetch = ((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/runs?')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: { id: 'R', defaultDatasetId: 'D', status: 'SUCCEEDED', usageTotalUsd: 0.004 },
        }), { status: 201 }));
      }
      return Promise.resolve(new Response(JSON.stringify([video('1'), video('2')]), { status: 200 }));
    }) as typeof fetch;

    const res = await scrapeTikTok(opts);
    expect(res.costCents).toBe(1); // ceil($0.004) — not the 2c model
  });

  test('the kill switch forces the legacy sync endpoint', async () => {
    process.env.APIFY_RESUMABLE_RUNS = '0';
    const res = await scrapeTikTok(opts);
    expect(calls.some(u => u.includes('run-sync-get-dataset-items'))).toBe(true);
    expect(res.actorRunId).toBeNull();
  });

  test('a failed start still produces a scrape via the sync fallback', async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/runs?')) return Promise.resolve(new Response('nope', { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify([video('1')]), { status: 200 }));
    }) as typeof fetch;

    const res = await scrapeTikTok(opts);
    expect(res.items.length).toBe(1);
    expect(res.actorRunId).toBeNull(); // no receipt, but the refresh still ran
  });
});

describe('scrape receipts — when it is safe to reuse a dataset', () => {
  const key = 'tiktok|hashtag|vibecoding';
  const fresh = { datasetId: 'DS1', canonicalKey: key, at: Date.now() };

  test('a fresh receipt for the same query is reused', () => {
    const payload = withScrapeReceipt('{"limitOverride":5}', fresh);
    expect(readScrapeReceipt(payload, key)?.datasetId).toBe('DS1');
  });

  test('writing a receipt preserves the rest of the payload', () => {
    const payload = withScrapeReceipt('{"limitOverride":5}', fresh);
    expect(JSON.parse(payload).limitOverride).toBe(5);
  });

  test("another query's dataset is NEVER reused", () => {
    // The failure mode this guards is not overspending, it is applying one
    // source's videos to a different source.
    const payload = withScrapeReceipt('{}', fresh);
    expect(readScrapeReceipt(payload, 'tiktok|hashtag|somethingelse')).toBeUndefined();
  });

  test('a stale receipt is ignored — a refresh must return current results', () => {
    const old = { ...fresh, at: Date.now() - SCRAPE_RECEIPT_TTL_MS - 1 };
    expect(readScrapeReceipt(withScrapeReceipt('{}', old), key)).toBeUndefined();
  });

  test('a receipt inside the TTL is still good', () => {
    const recent = { ...fresh, at: Date.now() - (SCRAPE_RECEIPT_TTL_MS - 1000) };
    expect(readScrapeReceipt(withScrapeReceipt('{}', recent), key)?.datasetId).toBe('DS1');
  });

  test('malformed payloads degrade to "scrape again", never to a throw', () => {
    expect(readScrapeReceipt('not json at all', key)).toBeUndefined();
    expect(readScrapeReceipt('{}', key)).toBeUndefined();
    expect(readScrapeReceipt(null, key)).toBeUndefined();
    expect(readScrapeReceipt('{"scrapeReceipt":{"canonicalKey":"' + key + '","at":1}}', key)).toBeUndefined();
  });

  test('a receipt with a non-numeric timestamp is not trusted', () => {
    const bad = '{"scrapeReceipt":{"datasetId":"DS1","canonicalKey":"' + key + '","at":"now"}}';
    expect(readScrapeReceipt(bad, key)).toBeUndefined();
  });
});
