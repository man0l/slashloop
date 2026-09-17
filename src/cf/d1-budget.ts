import { AsyncLocalStorage } from 'node:async_hooks';

const budget = new AsyncLocalStorage<{ used: number; limit: number }>();

export function withD1Budget<T>(work: () => T, limit = 50): T {
  return budget.run({ used: 0, limit }, work);
}

export function countD1Queries(count: number): void {
  const current = budget.getStore();
  if (current) current.used += count;
}

export function remainingD1Queries(): number {
  const current = budget.getStore();
  return current ? Math.max(0, current.limit - current.used) : Infinity;
}
