import { describe, expect, test } from 'bun:test';
import {
  REFRESH_BOOTSTRAP_CAP,
  REFRESH_INCREMENTAL_CAP,
  REFRESH_INCREMENTAL_DEFAULT,
} from './refresh-policy.js';

describe('refresh-policy constants', () => {
  test('incremental default is small (new outliers, not full catalogue)', () => {
    expect(REFRESH_INCREMENTAL_DEFAULT).toBeLessThanOrEqual(10);
    expect(REFRESH_INCREMENTAL_DEFAULT).toBeGreaterThanOrEqual(3);
  });

  test('bootstrap cap is larger than incremental but still bounded', () => {
    expect(REFRESH_BOOTSTRAP_CAP).toBeGreaterThan(REFRESH_INCREMENTAL_DEFAULT);
    expect(REFRESH_BOOTSTRAP_CAP).toBeLessThanOrEqual(30);
  });

  test('incremental cap does not exceed bootstrap', () => {
    expect(REFRESH_INCREMENTAL_CAP).toBeLessThanOrEqual(REFRESH_BOOTSTRAP_CAP);
    expect(REFRESH_INCREMENTAL_CAP).toBeGreaterThanOrEqual(REFRESH_INCREMENTAL_DEFAULT);
  });
});
