import { describe, expect, test } from 'bun:test';
import { PLAN_RETENTION_MAX, defaultRetentionDays, retentionCeiling, validateRetentionDays } from './retention.js';

describe('media retention policy', () => {
  test('every plan allows a 1-month window and the default seed is 30 days', () => {
    for (const plan of ['free', 'creator', 'pro']) {
      expect(retentionCeiling(plan)).toBe(30);
      expect(PLAN_RETENTION_MAX[plan]).toBe(30);
    }
    expect(defaultRetentionDays('thumb')).toBe(30);
    expect(defaultRetentionDays('media')).toBe(30);
  });

  test('30 days validates on every plan and 31 is rejected', () => {
    for (const plan of ['free', 'creator', 'pro']) {
      expect(validateRetentionDays(plan, 30, 'Thumb retention')).toEqual({ ok: true, value: 30 });
      const rejected = validateRetentionDays(plan, 31, 'Thumb retention');
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.ceiling).toBe(30);
    }
  });
});
