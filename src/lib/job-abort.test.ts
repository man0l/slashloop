import { describe, expect, test } from 'bun:test';
import {
  currentJobSignal, jobAborted, jobBudgetRemainingMs, repeatedTimeoutIsTerminal, withJobBudget,
} from './job-abort.js';

describe('job budget scope', () => {
  test('is empty outside a job and visible inside one', async () => {
    expect(currentJobSignal()).toBeUndefined();
    expect(jobAborted()).toBe(false);
    expect(jobBudgetRemainingMs()).toBe(Infinity);

    const ctl = new AbortController();
    await withJobBudget(ctl.signal, Date.now() + 5_000, async () => {
      await Promise.resolve();
      expect(currentJobSignal()).toBe(ctl.signal);
      expect(jobAborted()).toBe(false);
      expect(jobBudgetRemainingMs()).toBeLessThanOrEqual(5_000);
      ctl.abort();
      expect(jobAborted()).toBe(true);
    });
  });
});

describe('repeatedTimeoutIsTerminal', () => {
  const timeout = 'job timed out after 120000ms';
  const row = (over: Record<string, unknown> = {}) =>
    ({ kind: 'refresh', attempts: 2, lastError: timeout, ...over }) as Parameters<typeof repeatedTimeoutIsTerminal>[0];

  test('a second consecutive timeout on a refresh is terminal', () => {
    expect(repeatedTimeoutIsTerminal(row(), timeout)).toBe(true);
    expect(repeatedTimeoutIsTerminal(row({ lastError: 'impit: Request was aborted through AbortSignal' }), timeout)).toBe(true);
  });

  test('the first timeout keeps its retry lives', () => {
    expect(repeatedTimeoutIsTerminal(row({ attempts: 1, lastError: null }), timeout)).toBe(false);
  });

  test('a timeout after an unrelated failure is not a repeat', () => {
    expect(repeatedTimeoutIsTerminal(row({ lastError: 'actor died' }), timeout)).toBe(false);
  });

  test('a non-timeout failure is never classified here', () => {
    expect(repeatedTimeoutIsTerminal(row(), 'actor died')).toBe(false);
  });

  test('only refresh jobs are affected', () => {
    expect(repeatedTimeoutIsTerminal(row({ kind: 'analyze' }), timeout)).toBe(false);
  });
});
