// ---------------------------------------------------------------------------
// Worker-side Prometheus gauges (SLA-359).
//
// The fallback backlog (MediaJob rows parked as fallback_d1/queued_remote after
// a failed PG publish) lives in D1, so queue-api's PG-side /metrics cannot see
// it. The maintenance worker already measures it once per reclaim sweep
// (reconcileFallbackJobs); this module keeps the latest sample in memory and
// serves it from an opt-in listener (WORKER_METRICS_PORT, unset = off).
//
// Series are ABSENT until the first successful sweep, and a failed sweep never
// records a sample — a missing series must not read as "backlog 0".
// Only the maintenance worker sweeps, so only its listener carries series.
// Alert rule: deploy/queue-alerts.yml (QueueFallbackBacklogStuck).
// ---------------------------------------------------------------------------

import { createServer, type Server } from 'node:http';

export interface FallbackSweepSample {
  /** Rows parked at sweep start (before republish). */
  parked: number;
  /** Age in seconds of the oldest parked row at sweep start; -1 when none. */
  oldestAgeSeconds: number;
  /** Epoch ms the sweep ran. */
  sweptAtMs: number;
}

let latest: FallbackSweepSample | null = null;

export function recordFallbackSweep(
  fallback: { backlog: number; oldestAt: Date | null },
  nowMs: number = Date.now(),
): void {
  latest = {
    parked: fallback.backlog,
    oldestAgeSeconds: fallback.oldestAt
      ? Math.max(0, Math.round((nowMs - fallback.oldestAt.getTime()) / 1000))
      : -1,
    sweptAtMs: nowMs,
  };
}

export function resetWorkerMetricsForTests(): void {
  latest = null;
}

export function renderWorkerPrometheus(): string {
  const lines: string[] = [];
  if (latest) {
    lines.push('# HELP slashloop_worker_fallback_backlog_parked Fallback rows parked in D1 at the last reclaim sweep (start-of-sweep snapshot).');
    lines.push('# TYPE slashloop_worker_fallback_backlog_parked gauge');
    lines.push(`slashloop_worker_fallback_backlog_parked ${latest.parked}`);
    lines.push('# HELP slashloop_worker_fallback_oldest_age_seconds Age of the oldest parked fallback row at the last sweep (-1 when empty).');
    lines.push('# TYPE slashloop_worker_fallback_oldest_age_seconds gauge');
    lines.push(`slashloop_worker_fallback_oldest_age_seconds ${latest.oldestAgeSeconds}`);
    lines.push('# HELP slashloop_worker_fallback_last_sweep_timestamp_seconds Unix time of the last successful fallback sweep.');
    lines.push('# TYPE slashloop_worker_fallback_last_sweep_timestamp_seconds gauge');
    lines.push(`slashloop_worker_fallback_last_sweep_timestamp_seconds ${Math.floor(latest.sweptAtMs / 1000)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Env value -> listen port, or null (off) when unset/invalid. */
export function parseMetricsPort(raw: string | undefined): number | null {
  const n = Number((raw ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Serve GET /metrics. Bind to the internal network only (no Traefik route);
 * the body carries counts and ages, no identifiers.
 */
export function startWorkerMetricsServer(port: number, host?: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderWorkerPrometheus());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => resolve(server);
    if (host) server.listen(port, host, ready);
    else server.listen(port, ready);
  });
}
