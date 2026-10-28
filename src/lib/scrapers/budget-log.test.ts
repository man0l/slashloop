import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logBudgetRefusal, resetBudgetRefusalLog } from './budget.js';

describe('logBudgetRefusal', () => {
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  beforeEach(() => {
    resetBudgetRefusalLog();
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    error = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  test('warns (never errors) and logs once a minute per workspace', () => {
    logBudgetRefusal('ws-a', () => 'a1', 1_000);
    logBudgetRefusal('ws-a', () => 'a2', 30_000);
    logBudgetRefusal('ws-b', () => 'b1', 30_000);
    logBudgetRefusal('ws-a', () => 'a3', 61_001);
    expect(warn.mock.calls.map((c: unknown[]) => c[0])).toEqual(['a1', 'b1', 'a3']);
    expect(error).not.toHaveBeenCalled();
  });
});
