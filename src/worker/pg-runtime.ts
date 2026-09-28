// ---------------------------------------------------------------------------
// VPS-only PG queue runtime (SLA-16). Cloudflare never imports this file.
//
// When QUEUE_DATABASE_URL is set, workers can claim PG-owned kinds and route
// complete/fail/yield through PgQueue, then mirror the D1 projection row
// (same id, queueOwner=pg) so UI/API readers stay current. The mirror is
// gated by queue.d1.projection (default `terminal`): done/failed only.
// Yield and non-terminal requeue stay on PG — the D1 row remains `queued`
// from enqueue, which is what pollers already treat as in progress.
// While every kind still resolves to D1 this module connects (if configured)
// and claims nothing.
// ---------------------------------------------------------------------------

import { hostname } from 'node:os';
import { refundCredits } from '../lib/credits.js';
import {
  completeJob,
  failJob,
  jobCreditTool,
  setJobLifecycleSink,
  yieldJob,
} from '../lib/jobs.js';
import { PgQueue, type QueueDb } from '../queue/pg.js';
import { toMediaJobShape, type MediaJobShape } from '../queue/contract.js';
import { getQueueD1ProjectionMode, shouldMirrorLifecycleToD1 } from '../queue/transport.js';

const owned = new Set<string>();

export function workerId(): string {
  return `${process.env.HOSTNAME || hostname()}:${process.pid}`;
}

export function markPgOwned(ids: readonly string[]): void {
  for (const id of ids) owned.add(id);
}

export function isPgOwned(id: string): boolean {
  return owned.has(id);
}

function parseResult(payloadJson?: string): unknown {
  if (payloadJson === undefined) return undefined;
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}

export async function connectPgQueue(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgQueue | null> {
  const url = (env.QUEUE_DATABASE_URL ?? '').trim();
  if (!url) return null;
  const mod = (await import('pg')) as unknown as {
    Pool: new (opts: { connectionString: string; max?: number }) => {
      query: (text: string, values?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>;
    };
  };
  const pool = new mod.Pool({ connectionString: url, max: 2 });
  const db: QueueDb = {
    query: async (text, values) => {
      const r = await pool.query(text, values);
      return { rows: r.rows as never[], rowCount: r.rowCount ?? 0 };
    },
  };
  const queue = new PgQueue(db, {
    onTerminalRefund: async (job) => {
      if (!job.opId || !job.preAuthCredits) return;
      await refundCredits(
        job.workspaceId,
        job.preAuthCredits,
        jobCreditTool(job.kind),
        `${job.opId}:fail`,
        'call_failed',
      );
    },
  });
  setJobLifecycleSink({
    async completeJob(id, analysisId, payloadJson) {
      if (!owned.has(id)) return false;
      await queue.completeJob(id, analysisId, parseResult(payloadJson));
      owned.delete(id);
      if (shouldMirrorLifecycleToD1(await getQueueD1ProjectionMode(), 'complete', true)) {
        await completeJob(id, analysisId, payloadJson, { forceD1: true }).catch((err: Error) => {
          console.warn(`[worker] D1 projection complete failed for ${id.slice(0, 8)}: ${err.message}`);
        });
      }
      return true;
    },
    async failJob(id, message, opts) {
      if (!owned.has(id)) return null;
      const result = await queue.failJob(id, message, opts);
      owned.delete(id);
      // Pass PG's terminal bit. D1 attempts stay at the enqueue value (claims
      // are on PG), so recomputing terminal from the projection would leave
      // a terminally failed job looking `queued` to await_job.
      if (shouldMirrorLifecycleToD1(await getQueueD1ProjectionMode(), 'fail', result.terminal)) {
        await failJob(id, message, { terminal: result.terminal, forceD1: true }).catch((err: Error) => {
          console.warn(`[worker] D1 projection fail failed for ${id.slice(0, 8)}: ${err.message}`);
        });
      }
      return result;
    },
    async yieldJob(id, reason) {
      if (!owned.has(id)) return false;
      await queue.yieldJob(id, reason);
      owned.delete(id);
      if (shouldMirrorLifecycleToD1(await getQueueD1ProjectionMode(), 'yield', false)) {
        await yieldJob(id, reason, { forceD1: true }).catch((err: Error) => {
          console.warn(`[worker] D1 projection yield failed for ${id.slice(0, 8)}: ${err.message}`);
        });
      }
      return true;
    },
  });
  return queue;
}

export async function claimPgJobs(
  queue: PgQueue,
  kinds: string[],
  limit: number,
): Promise<MediaJobShape[]> {
  if (kinds.length === 0 || limit <= 0) return [];
  const rows = await queue.claimBatch(kinds, {
    batchSize: limit,
    workerId: workerId(),
  });
  markPgOwned(rows.map((r) => r.job_id));
  return rows.map(toMediaJobShape);
}

/** Test seam. */
export function resetPgOwnedForTests(): void {
  owned.clear();
  setJobLifecycleSink(null);
}
