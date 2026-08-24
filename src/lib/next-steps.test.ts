import { describe, expect, test } from 'bun:test';
import { costBlock, listScrapeCostCents } from './next-steps.js';
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

  test('listScrapeCostCents quotes whichever provider is active', () => {
    // Both branches must be positive and monotonic in results — the exact
    // number depends on SCRAPER_PROVIDER in the environment (Apify per-result
    // vs proxy per-GB), which is the point of the helper.
    const one = listScrapeCostCents(1);
    const fifty = listScrapeCostCents(50);
    expect(one).toBeGreaterThan(0);
    expect(fifty).toBeGreaterThan(one);
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
