import { afterEach, describe, expect, test } from 'bun:test';
import { costBlock, downloadCeilingBytes, downloadCostCents, listScrapeCostCents, scraperCostLabel } from './next-steps.js';
import { ESTIMATED_LOOKUP_BYTES, maxVideoBytes } from './scrapers/index.js';
import { bytesToCents } from './scrapers/bandwidth.js';
import { ScriptDataSchema, SCRIPT_FORMATS } from '../analysis/schema.js';

describe('costBlock', () => {
  test('credits-only block', () => {
    expect(costBlock(2, { remaining: 98 })).toEqual({
      credits: 2,
      remaining: 98,
    });
  });

  test('rounds scraper cents and flags quotes', () => {
    const block = costBlock(0, { scraperCents: 3.70001, quoted: true, note: 'worst case' });
    expect(block.scraperCents).toBe(3.7);
    expect(block.quoted).toBe(true);
    expect(block.note).toBe('worst case');
    expect(block.remaining).toBeUndefined();
  });

  test('listScrapeCostCents quotes the active provider', () => {
    const saved = process.env.SCRAPER_PROVIDER;
    try {
      // Proxy bills per GB with a 1-cent floor, so small scrapes tie; they never go down.
      delete process.env.SCRAPER_PROVIDER;
      const one = listScrapeCostCents(1);
      expect(one).toBeGreaterThan(0);
      expect(listScrapeCostCents(50)).toBeGreaterThanOrEqual(one);

      // Apify bills per result, so it is strictly monotonic.
      process.env.SCRAPER_PROVIDER = 'apify';
      expect(listScrapeCostCents(50)).toBeGreaterThan(listScrapeCostCents(1));
    } finally {
      if (saved === undefined) delete process.env.SCRAPER_PROVIDER;
      else process.env.SCRAPER_PROVIDER = saved;
    }
  });
});

describe('proxy quotes use the existing gigabyte helpers', () => {
  const saved = { p: process.env.SCRAPER_PROVIDER, u: process.env.SCRAPER_PROXY_URL, k: process.env.APIFY_API_KEY };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => {
    restore('SCRAPER_PROVIDER', saved.p);
    restore('SCRAPER_PROXY_URL', saved.u);
    restore('APIFY_API_KEY', saved.k);
  });

  test('proxy active: list scrapes are quoted in traffic, not Apify dollars', () => {
    process.env.SCRAPER_PROVIDER = 'proxy';
    process.env.SCRAPER_PROXY_URL = 'user:pass@gw.example.com:8080';
    expect(scraperCostLabel(20)).toContain('proxy traffic');
    expect(scraperCostLabel(20)).not.toContain('Apify');
  });

  test('download ceiling is the proxy video ceiling plus the watch-page lookup', () => {
    process.env.SCRAPER_PROXY_URL = 'user:pass@gw.example.com:8080';
    const bytes = downloadCeilingBytes();
    expect(bytes).toBe(maxVideoBytes() + ESTIMATED_LOOKUP_BYTES);
    expect(downloadCostCents()).toBe(bytesToCents(bytes!));
  });

  test('no proxy configured: downloads fall back to the Apify per-video ceiling', () => {
    delete process.env.SCRAPER_PROXY_URL;
    process.env.SCRAPER_PROVIDER = 'apify';
    process.env.APIFY_API_KEY = 'k';
    expect(downloadCeilingBytes()).toBeNull();
    expect(downloadCostCents()).toBe(1);
  });
});

describe('ScriptDataSchema', () => {
  const valid = {
    format: 'pov_demo',
    hook: 'POV: your app just saved you 3 hours',
    beats: [
      { timestampSec: 0, voiceover: 'hook line', visual: 'screen recording of the app' },
      { timestampSec: 4, voiceover: 'feature beat', onScreenText: 'one tap', visual: 'tap-through of the core flow' },
      { timestampSec: 12, voiceover: 'proof beat', visual: 'before/after split' },
    ],
    cta: 'Link in bio — it is free',
    caption: 'the app that pays for itself #buildinpublic',
    hashtags: ['#buildinpublic', '#indiedev'],
    whyThisWorks: 'Screen-recording POV removes production cost from the loop.',
  };

  test('accepts a well-formed script', () => {
    expect(ScriptDataSchema.safeParse(valid).success).toBe(true);
  });

  test('rejects fewer than 3 beats', () => {
    expect(ScriptDataSchema.safeParse({ ...valid, beats: valid.beats.slice(0, 2) }).success).toBe(false);
  });

  test('rejects a missing hook', () => {
    const { hook: _hook, ...noHook } = valid;
    expect(ScriptDataSchema.safeParse(noHook).success).toBe(false);
  });

  test('SCRIPT_FORMATS covers the five app-promo formats', () => {
    expect(SCRIPT_FORMATS).toEqual([
      'pov_demo', 'problem_solution', 'apps_that_feel_illegal', 'build_in_public', 'listicle',
    ]);
  });
});
