// Metrics collection/rendering without a real database.
import { describe, expect, test } from 'bun:test';
import {
  collectQueueMetrics,
  RATE_LIMIT_GATES,
  recordApiEvent,
  renderPrometheus,
  resetApiCountersForTests,
  snapshotApiCounters,
} from './metrics.js';
import type { QueueDb } from './pg.js';

function fakeDb(): QueueDb {
  return {
    query: async <T>(text: string): Promise<{ rows: T[]; rowCount: number }> => {
      if (text.includes('GROUP BY kind, state')) {
        const rows = [
          { kind: 'analyze', state: 'queued', count: '3' },
          { kind: 'refresh', state: 'running', count: '1' },
        ] as unknown as T[];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('age_seconds')) {
        const rows = [{ kind: 'analyze', age_seconds: '95.4' }] as unknown as T[];
        return { rows, rowCount: rows.length };
      }
      const rows = [{ running: '1', expired: '0' }] as unknown as T[];
      return { rows, rowCount: 1 };
    },
  };
}

describe('queue metrics', () => {
  test('collect + render prometheus text', async () => {
    resetApiCountersForTests();
    recordApiEvent({ kind: 'analyze', deduped: false, latencyMs: 12, status: 202 });
    recordApiEvent({ kind: 'analyze', deduped: true, latencyMs: 8, status: 202 });
    recordApiEvent({ kind: 'x', deduped: false, latencyMs: 0, status: 401 });
    recordApiEvent({ kind: 'x', deduped: false, latencyMs: 0, status: 409 });
    const snap = await collectQueueMetrics(fakeDb());
    expect(snap.depth).toEqual([
      { kind: 'analyze', state: 'queued', count: 3 },
      { kind: 'refresh', state: 'running', count: 1 },
    ]);
    expect(snap.oldestAge).toEqual([{ kind: 'analyze', seconds: 95 }]);
    const text = renderPrometheus(snap);
    expect(text).toContain('slashloop_queue_depth{kind="analyze",state="queued"} 3');
    expect(text).toContain('slashloop_queue_oldest_age_seconds{kind="analyze"} 95');
    expect(text).toContain('slashloop_queue_api_publish_total 2');
    expect(text).toContain('slashloop_queue_api_publish_deduped_total 1');
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="auth"} 1');
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="replay"} 1');
  });
});

// SLA-350: "rate limited" is untunable until you can tell WHICH limiter said no,
// so cause="rate_limit" is split by gate — and the split must never be joined by
// a second, gate-less rate_limit line, because QueueApiRejectsSpike sums
// `by (cause)` and a duplicate there would double-count every alert.
describe('rate-limit reject accounting', () => {
  function render(api: ReturnType<typeof snapshotApiCounters>): string {
    return renderPrometheus({ api, depth: [], oldestAge: [], running: 0, expiredLeases: 0, collectedAt: '' });
  }

  test('each gate lands in its own series and the total still matches', () => {
    resetApiCountersForTests();
    recordApiEvent({ kind: 'analyze', deduped: false, latencyMs: 0, status: 429, gate: 'per_key' });
    recordApiEvent({ kind: 'analyze', deduped: false, latencyMs: 0, status: 429, gate: 'per_key' });
    recordApiEvent({ kind: 'analyze', deduped: false, latencyMs: 0, status: 429, gate: 'per_workspace' });
    recordApiEvent({ kind: 'thumb', deduped: false, latencyMs: 0, status: 429, gate: 'per_kind_workspace' });

    const api = snapshotApiCounters();
    expect(api.rateLimitRejects).toBe(4);
    expect(api.rateLimitRejectsPerKey).toBe(2);
    expect(api.rateLimitRejectsPerWorkspace).toBe(1);
    expect(api.rateLimitRejectsPerKindWorkspace).toBe(1);
    expect(api.rateLimitRejectsUnattributed).toBe(0);

    const text = render(api);
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="rate_limit",gate="per_key"} 2');
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="rate_limit",gate="per_workspace"} 1');
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="rate_limit",gate="per_kind_workspace"} 1');
    expect(text).toContain('slashloop_queue_api_rejects_total{cause="rate_limit",gate="unknown"} 0');
    // Exactly one rate_limit line per gate, no aggregate twin.
    const rateLimitLines = text.split('\n').filter((l) => l.includes('cause="rate_limit"'));
    expect(rateLimitLines).toHaveLength(RATE_LIMIT_GATES.length + 1);
  });

  test('a 429 with no gate is counted, not dropped', () => {
    resetApiCountersForTests();
    recordApiEvent({ kind: 'analyze', deduped: false, latencyMs: 0, status: 429 });
    const api = snapshotApiCounters();
    expect(api.rateLimitRejects).toBe(1);
    expect(api.rateLimitRejectsUnattributed).toBe(1);
    expect(render(api)).toContain('slashloop_queue_api_rejects_total{cause="rate_limit",gate="unknown"} 1');
  });
});
