// (Lives in src/lib: bun shares one module registry across test files and
// every db.js-mocking test must sort AFTER src/store.test.ts. See
// rescore-stale.test.ts.)
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

interface Row { provider: string; costCents: number; units: number; refId: string | null }

let rows: Row[] = [];

// Fake UsageLog: filters on provider like the real queries do, so the tests
// prove which ledger each code path reads rather than echoing a stub value.
const matching = (where: any) => rows.filter(r => r.provider === where.provider);
mock.module('../db.js', () => ({
  db: {
    usageLog: {
      aggregate: async (args: any) => {
        const m = matching(args.where);
        return {
          _sum: {
            costCents: m.reduce((n, r) => n + r.costCents, 0),
            units: m.reduce((n, r) => n + r.units, 0),
          },
          _count: { _all: m.length },
        };
      },
      findMany: async (args: any) => matching(args.where),
    },
  },
}));

const { resetLedgerCache } = await import('./scrapers/bandwidth.js');
const { getScraperCapStatus, getScraperSpendBreakdown } = await import('./scraper-spend.js');
const { resetSpendCache } = await import('./spend-cap.js');

const ENV = ['SCRAPER_PROVIDER', 'SCRAPER_PROXY_URL', 'PROXY_TRAFFIC_CAP_GB', 'APIFY_SPEND_CAP_CENTS', 'APIFY_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  rows = HISTORY;
  resetSpendCache();
  resetLedgerCache();
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const HISTORY: Row[] = [
  { provider: 'apify', costCents: 120, units: 1, refId: 'source_scrape:s1' },
  { provider: 'apify', costCents: 30, units: 1, refId: 'video_download:v1' },
  { provider: 'proxy', costCents: 9, units: 2048, refId: null },
];

describe('getScraperCapStatus follows the active provider', () => {
  test('apify: reads the Apify ledger in cents', async () => {
    process.env.SCRAPER_PROVIDER = 'apify';
    process.env.APIFY_API_KEY = 'k';
    process.env.APIFY_SPEND_CAP_CENTS = '1000';

    const s = await getScraperCapStatus('w1');
    expect(s.capKind).toBe('apify');
    expect(s.unit).toBe('cents');
    expect(s.usedDisplay).toBe('$1.50');
    expect(s.capDisplay).toBe('$10.00');
    expect(s.message).toContain('OK');
  });

  test('proxy: reads the proxy ledger in bytes and names the proxy cap', async () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gw.example.com:8080';
    process.env.PROXY_TRAFFIC_CAP_GB = '1';

    const s = await getScraperCapStatus('w1');
    expect(s.capKind).toBe('proxy');
    expect(s.unit).toBe('bytes');
    expect(s.usedDisplay).toBe('2.00MB');
    expect(s.capDisplay).toBe('1.000GB');
    expect(s.breached).toBe(false);
  });

  test('proxy: breach message points at PROXY_TRAFFIC_CAP_GB, not the Apify cap', async () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gw.example.com:8080';
    process.env.PROXY_TRAFFIC_CAP_GB = '0.001';

    const s = await getScraperCapStatus('w1');
    expect(s.breached).toBe(true);
    expect(s.message).toContain('PROXY_TRAFFIC_CAP_GB');
    expect(s.message).not.toContain('APIFY_SPEND_CAP_CENTS');
  });
});

describe('getScraperSpendBreakdown keeps historical Apify rows', () => {
  test('with the proxy active, past provider=apify spend is still reported', async () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gw.example.com:8080';

    const { apify, proxy } = await getScraperSpendBreakdown('w1');
    expect(apify.totalCents).toBe(150);
    expect(apify.byActivity.source_scrape.cents).toBe(120);
    expect(apify.byActivity.video_download.cents).toBe(30);
    expect(proxy).toEqual({ totalCents: 9, totalKb: 2048, charges: 1 });
  });
});
