// ---------------------------------------------------------------------------
// queue-db + queue-api observability.
//
// Two halves:
// 1. collectQueueMetrics(db) — aggregate snapshot straight from queue_jobs
//    (depth + oldest age by kind/state, running/lease counts). No extra
//    tables, no write load: three GROUP BY queries on the claim/recovery
//    indexes.
// 2. In-process API counters (auth/rejection rates, publish latency, replay
//    and rate-limit rejects) recorded via recordApiEvent() and rendered with
//    renderPrometheus() for the /metrics endpoint (server.ts).
//    Backup age + last restore-test result are file/operator-fed gauges —
//    see deploy/queue-backup.sh (writes backup_age_seconds) and the Phase 0
//    baseline doc for the restore-test state source of truth.
//
// Alert thresholds live in deploy/queue-alerts.yml.
// ---------------------------------------------------------------------------

import type { QueueDb } from './pg.js';

export interface QueueMetricsSnapshot {
  collectedAt: string;
  /** queue_depth{kind,state} */
  depth: Array<{ kind: string; state: string; count: number }>;
  /** queue_oldest_age_seconds{kind} (queued only; -1 when empty) */
  oldestAge: Array<{ kind: string; seconds: number }>;
  /** queue_running_total + queue_expired_leases_total */
  running: number;
  expiredLeases: number;
  api: ApiCounters;
}

export interface ApiCounters {
  publishTotal: number;
  publishDeduped: number;
  publishLatencyMsSum: number;
  publishLatencyMsCount: number;
  authRejects: number;
  replayRejects: number;
  rateLimitRejects: number;
  bodyTooLargeRejects: number;
  validationRejects: number;
  internalErrors: number;
}

const counters: ApiCounters = {
  publishTotal: 0,
  publishDeduped: 0,
  publishLatencyMsSum: 0,
  publishLatencyMsCount: 0,
  authRejects: 0,
  replayRejects: 0,
  rateLimitRejects: 0,
  bodyTooLargeRejects: 0,
  validationRejects: 0,
  internalErrors: 0,
};

export function resetApiCountersForTests(): void {
  (Object.keys(counters) as Array<keyof ApiCounters>).forEach((k) => {
    counters[k] = 0;
  });
}

export function snapshotApiCounters(): ApiCounters {
  return { ...counters };
}

/** Called by server.ts on every publish outcome (and by tests directly). */
export function recordApiEvent(info: {
  kind: string;
  deduped: boolean;
  latencyMs: number;
  status: number;
}): void {
  if (info.status === 202) {
    counters.publishTotal++;
    counters.publishLatencyMsSum += info.latencyMs;
    counters.publishLatencyMsCount++;
    if (info.deduped) counters.publishDeduped++;
  } else if (info.status === 401) counters.authRejects++;
  else if (info.status === 409) counters.replayRejects++;
  else if (info.status === 429) counters.rateLimitRejects++;
  else if (info.status === 413) counters.bodyTooLargeRejects++;
  else if (info.status === 422) counters.validationRejects++;
  else if (info.status >= 500) counters.internalErrors++;
}

export async function collectQueueMetrics(db: QueueDb): Promise<QueueMetricsSnapshot> {
  const depth = await db.query<{ kind: string; state: string; count: string }>(
    `SELECT kind, state, COUNT(*)::text AS count
       FROM queue_jobs
      WHERE state IN ('queued','running')
      GROUP BY kind, state ORDER BY kind, state`,
  );
  const oldest = await db.query<{ kind: string; age_seconds: string | null }>(
    `SELECT kind, EXTRACT(EPOCH FROM (now() - MIN(created_at)))::text AS age_seconds
       FROM queue_jobs
      WHERE state = 'queued'
      GROUP BY kind ORDER BY kind`,
  );
  const leases = await db.query<{ running: string; expired: string }>(
    `SELECT COUNT(*) FILTER (WHERE state = 'running')::text AS running,
            COUNT(*) FILTER (WHERE state = 'running' AND lease_expires_at < now())::text AS expired
       FROM queue_jobs`,
  );
  const leaseRow = leases.rows[0];
  return {
    collectedAt: new Date().toISOString(),
    depth: depth.rows.map((r) => ({ kind: r.kind, state: r.state, count: Number(r.count) })),
    oldestAge: oldest.rows.map((r) => ({
      kind: r.kind,
      seconds: r.age_seconds == null ? -1 : Math.max(0, Math.floor(Number(r.age_seconds))),
    })),
    running: leaseRow ? Number(leaseRow.running) : 0,
    expiredLeases: leaseRow ? Number(leaseRow.expired) : 0,
    api: snapshotApiCounters(),
  };
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderPrometheus(s: QueueMetricsSnapshot): string {
  const lines: string[] = [];
  lines.push('# HELP slashloop_queue_depth Jobs by kind and state.');
  lines.push('# TYPE slashloop_queue_depth gauge');
  for (const d of s.depth) {
    lines.push(`slashloop_queue_depth{kind="${esc(d.kind)}",state="${esc(d.state)}"} ${d.count}`);
  }
  lines.push('# HELP slashloop_queue_oldest_age_seconds Oldest queued job age by kind (-1 when empty).');
  lines.push('# TYPE slashloop_queue_oldest_age_seconds gauge');
  for (const o of s.oldestAge) {
    lines.push(`slashloop_queue_oldest_age_seconds{kind="${esc(o.kind)}"} ${o.seconds}`);
  }
  lines.push('# HELP slashloop_queue_running_total Running jobs holding a lease.');
  lines.push('# TYPE slashloop_queue_running_total gauge');
  lines.push(`slashloop_queue_running_total ${s.running}`);
  lines.push('# HELP slashloop_queue_expired_leases_total Running jobs past their lease.');
  lines.push('# TYPE slashloop_queue_expired_leases_total gauge');
  lines.push(`slashloop_queue_expired_leases_total ${s.expiredLeases}`);
  lines.push('# HELP slashloop_queue_api_publish_total Accepted publishes (202).');
  lines.push('# TYPE slashloop_queue_api_publish_total counter');
  lines.push(`slashloop_queue_api_publish_total ${s.api.publishTotal}`);
  lines.push('# HELP slashloop_queue_api_publish_deduped_total Dedupe replays returned without new work.');
  lines.push('# TYPE slashloop_queue_api_publish_deduped_total counter');
  lines.push(`slashloop_queue_api_publish_deduped_total ${s.api.publishDeduped}`);
  const avg =
    s.api.publishLatencyMsCount > 0
      ? s.api.publishLatencyMsSum / s.api.publishLatencyMsCount
      : 0;
  lines.push('# HELP slashloop_queue_api_publish_latency_ms_avg Average publish latency.');
  lines.push('# TYPE slashloop_queue_api_publish_latency_ms_avg gauge');
  lines.push(`slashloop_queue_api_publish_latency_ms_avg ${avg.toFixed(1)}`);
  lines.push('# HELP slashloop_queue_api_rejects_total Rejections by cause.');
  lines.push('# TYPE slashloop_queue_api_rejects_total counter');
  lines.push(`slashloop_queue_api_rejects_total{cause="auth"} ${s.api.authRejects}`);
  lines.push(`slashloop_queue_api_rejects_total{cause="replay"} ${s.api.replayRejects}`);
  lines.push(`slashloop_queue_api_rejects_total{cause="rate_limit"} ${s.api.rateLimitRejects}`);
  lines.push(`slashloop_queue_api_rejects_total{cause="body_too_large"} ${s.api.bodyTooLargeRejects}`);
  lines.push(`slashloop_queue_api_rejects_total{cause="validation"} ${s.api.validationRejects}`);
  lines.push(`slashloop_queue_api_rejects_total{cause="internal"} ${s.api.internalErrors}`);
  lines.push('');
  return lines.join('\n');
}
