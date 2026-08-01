// POST /api/jobs/refresh — drain the `refresh` queue.
//
// A separate route from /api/jobs/analyze on purpose. Both are capped at 60s,
// and a refresh scrape can use most of that on its own; sharing one endpoint
// would let a long scrape starve the analyze queue (and vice versa) because a
// single invocation drains until its own reserve runs out. Separate routes
// means separate invocations and separate budgets.
//
// Guarded by CRON_SECRET, same as the analyze worker. Reached two ways:
//   - dispatchWorker('refresh'), a best-effort poke at enqueue time
//   - the pg_cron drain, which is what correctness actually rests on
//
// See src/lib/refresh.ts for why this pipeline cannot run inside an MCP tool
// call: the scrape consumes the request's budget and everything after it —
// including the cross-source rescore the refresh was bought for — gets killed.

import { claimNextJob, completeJob, failJob, reclaimStuckJobs, type RefreshJobPayload } from '../../src/lib/jobs.js';
import { runRefresh } from '../../src/lib/refresh.js';

/**
 * Stop claiming new work with this much of the budget left.
 *
 * A refresh needs materially more headroom than an analyze job: the scrape is
 * a single opaque call that cannot be interrupted, so starting one with 20s
 * left means it is killed mid-flight and the row goes stuck. Better to leave
 * it queued for the next drain a minute later.
 */
const RESERVE_MS = 45_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

// Named method export selects Vercel's Web-standard signature — see api/mcp.ts.
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'Unauthorized' });

  const startedAt = Date.now();
  const processed: Array<{
    jobId: string; sourceId: string | null; ok: boolean;
    itemsPulled?: number; newVideos?: number; rescoredSources?: number; error?: string;
  }> = [];

  // Recover abandoned claims before taking new work — the single place the
  // retry policy is applied (see the pg_cron migration for why it is not
  // duplicated in SQL).
  const reclaimed = await reclaimStuckJobs();

  while (Date.now() - startedAt < RESERVE_MS) {
    const job = await claimNextJob('refresh');
    if (!job) break;

    if (!job.sourceId) {
      // Cannot happen given the MediaJob_one_target CHECK, but a job with no
      // target would otherwise loop forever being claimed and re-queued.
      await failJob(job.id, 'refresh job has no sourceId');
      processed.push({ jobId: job.id, sourceId: null, ok: false, error: 'no sourceId' });
      continue;
    }

    let payload: RefreshJobPayload = {};
    try {
      payload = JSON.parse(job.payloadJson) as RefreshJobPayload;
    } catch {
      // A malformed payload is not worth failing the job over — the defaults
      // (the source's own videoLimit) are exactly what we want anyway.
    }

    try {
      const result = await runRefresh({
        workspaceId: job.workspaceId,
        sourceId: job.sourceId,
        limitOverride: payload.limitOverride,
      });

      if (!result.ok) {
        // A refusal (cap breached, insufficient credits) is terminal in
        // substance — retrying will refuse identically until the user acts —
        // but failJob's attempt counting handles that adequately and keeps one
        // code path. runRefresh has already refunded anything it debited.
        const message = result.errors.join('; ') || result.refusal || 'refresh refused';
        const { terminal } = await failJob(job.id, message);
        console.warn(`[jobs] refresh job ${job.id} refused (terminal=${terminal}): ${message}`);
        processed.push({ jobId: job.id, sourceId: job.sourceId, ok: false, error: message });
        continue;
      }

      await completeJob(job.id, null);
      processed.push({
        jobId: job.id,
        sourceId: job.sourceId,
        ok: true,
        itemsPulled: result.itemsPulled,
        newVideos: result.newVideos,
        rescoredSources: result.rescoredSources.length,
      });
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);
      console.warn(`[jobs] refresh job ${job.id} failed (terminal=${terminal}): ${message}`);
      processed.push({ jobId: job.id, sourceId: job.sourceId, ok: false, error: message });
    }
  }

  return json(200, {
    ok: true,
    reclaimed,
    processed,
    drained: processed.length,
    elapsedMs: Date.now() - startedAt,
  });
}

export async function GET(): Promise<Response> {
  return json(405, { error: 'Method not allowed' });
}
