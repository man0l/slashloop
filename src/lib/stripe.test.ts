import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { priceIdFor } from './stripe.js';

const NAMES = [
  'STRIPE_MODE', 'STRIPE_PRICES',
  'STRIPE_PRICE_PRO_MONTH', 'STRIPE_PRICE_CREATOR_YEAR',
  'STRIPE_TEST_PRICE_PRO_MONTH',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n]; }
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
  }
});

describe('priceIdFor', () => {
  test('reads the STRIPE_PRICES JSON bundle for the active mode', () => {
    process.env.STRIPE_PRICES = JSON.stringify({
      STRIPE_PRICE_PRO_MONTH: 'price_live_pro_m',
      STRIPE_TEST_PRICE_PRO_MONTH: 'price_test_pro_m',
    });
    expect(priceIdFor('pro', 'month')).toBe('price_live_pro_m');
    process.env.STRIPE_MODE = 'test';
    expect(priceIdFor('pro', 'month')).toBe('price_test_pro_m');
  });

  test('falls back to the legacy per-name var for ids the bundle lacks', () => {
    process.env.STRIPE_PRICES = JSON.stringify({ STRIPE_PRICE_PRO_MONTH: 'price_bundle' });
    process.env.STRIPE_PRICE_CREATOR_YEAR = 'price_legacy';
    expect(priceIdFor('creator', 'year')).toBe('price_legacy');
    expect(priceIdFor('pro', 'month')).toBe('price_bundle');
  });

  test('legacy vars alone still work, and the bundle wins when both are set', () => {
    process.env.STRIPE_PRICE_PRO_MONTH = 'price_legacy';
    expect(priceIdFor('pro', 'month')).toBe('price_legacy');
    process.env.STRIPE_PRICES = JSON.stringify({ STRIPE_PRICE_PRO_MONTH: 'price_bundle' });
    expect(priceIdFor('pro', 'month')).toBe('price_bundle');
  });

  test('malformed or non-object bundles are ignored, not thrown on', () => {
    process.env.STRIPE_PRICE_PRO_MONTH = 'price_legacy';
    for (const bad of ['{not json', '["x"]', 'null', '"s"', '{"STRIPE_PRICE_PRO_MONTH":42}']) {
      process.env.STRIPE_PRICES = bad;
      expect(priceIdFor('pro', 'month')).toBe('price_legacy');
    }
  });

  test('names the missing var when neither source has the id', () => {
    expect(() => priceIdFor('pro', 'year')).toThrow('STRIPE_PRICE_PRO_YEAR is not set');
  });
});
