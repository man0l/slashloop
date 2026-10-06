import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import {
  parseMetricsPort,
  recordFallbackSweep,
  renderWorkerPrometheus,
  resetWorkerMetricsForTests,
  startWorkerMetricsServer,
} from './metrics.js';

afterEach(() => resetWorkerMetricsForTests());

describe('worker fallback-backlog gauges', () => {
  test('emits no series before the first successful sweep', () => {
    expect(renderWorkerPrometheus()).not.toContain('slashloop_worker_fallback');
  });

  test('renders backlog, reconcile lag and sweep time from the sweep snapshot', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    recordFallbackSweep({ backlog: 7, oldestAt: new Date(now - 420_000) }, now);
    const out = renderWorkerPrometheus();
    expect(out).toContain('slashloop_worker_fallback_backlog_parked 7\n');
    expect(out).toContain('slashloop_worker_fallback_oldest_age_seconds 420\n');
    expect(out).toContain(`slashloop_worker_fallback_last_sweep_timestamp_seconds ${now / 1000}\n`);
    expect(out).toContain('# TYPE slashloop_worker_fallback_backlog_parked gauge');
  });

  test('an empty backlog reports 0 / -1 so the gauge drops back instead of going stale', () => {
    recordFallbackSweep({ backlog: 7, oldestAt: new Date(0) }, 1_000_000);
    recordFallbackSweep({ backlog: 0, oldestAt: null }, 2_000_000);
    const out = renderWorkerPrometheus();
    expect(out).toContain('slashloop_worker_fallback_backlog_parked 0\n');
    expect(out).toContain('slashloop_worker_fallback_oldest_age_seconds -1\n');
  });

  test('a clock-skewed oldestAt in the future clamps to 0', () => {
    recordFallbackSweep({ backlog: 1, oldestAt: new Date(5_000) }, 1_000);
    expect(renderWorkerPrometheus()).toContain('slashloop_worker_fallback_oldest_age_seconds 0\n');
  });
});

describe('parseMetricsPort', () => {
  test('unset, blank and invalid values leave the listener off', () => {
    for (const raw of [undefined, '', '  ', 'abc', '0', '-1', '70000', '1.5']) {
      expect(parseMetricsPort(raw)).toBeNull();
    }
  });
  test('accepts a valid port', () => {
    expect(parseMetricsPort(' 9464 ')).toBe(9464);
  });
});

describe('startWorkerMetricsServer', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  test('serves /metrics as Prometheus text and 404s everything else', async () => {
    recordFallbackSweep({ backlog: 3, oldestAt: new Date(Date.now() - 10_000) });
    server = await startWorkerMetricsServer(0, '127.0.0.1');
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toContain('slashloop_worker_fallback_backlog_parked 3');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
  });
});
