// Metrics collection/rendering without a real database.
import { describe, expect, test } from 'bun:test';
import {
  collectQueueMetrics,
  recordApiEvent,
  renderPrometheus,
  resetApiCountersForTests,
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
