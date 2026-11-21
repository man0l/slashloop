// Per-job phase timings, so a job that hits the worker's wall-clock cap says
// WHERE the time went (scrape vs scoring vs thumbnails vs D1) instead of just
// "job timed out after 120000ms". Advisory only: markPhase() is a no-op
// outside a scope and never throws.

import { AsyncLocalStorage } from 'node:async_hooks';

export class PhaseTracker {
  private marks: Array<{ name: string; at: number }> = [];

  constructor(private readonly now: () => number = Date.now) {
    this.mark('start');
  }

  mark(name: string): void {
    this.marks.push({ name, at: this.now() });
  }

  /** `start 0.1s > scrape 85.2s > score 34.0s (running)` — last phase is the in-flight one. */
  summary(): string {
    const end = this.now();
    return this.marks
      .map((m, i) => {
        const next = this.marks[i + 1]?.at ?? end;
        return `${m.name} ${((next - m.at) / 1000).toFixed(1)}s${i === this.marks.length - 1 ? ' (running)' : ''}`;
      })
      .join(' > ');
  }
}

const als = new AsyncLocalStorage<PhaseTracker>();

export function withPhaseTracker<T>(tracker: PhaseTracker, fn: () => Promise<T>): Promise<T> {
  return als.run(tracker, fn);
}

export function markPhase(name: string): void {
  try {
    als.getStore()?.mark(name);
  } catch {
    // Timing is advisory.
  }
}
