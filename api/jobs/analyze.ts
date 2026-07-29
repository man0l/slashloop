// POST /api/jobs/analyze — drain analyze jobs off the request path.
//
// See docs/media-storage-plan.md §3.3 and src/lib/jobs.ts for why this exists:
// a gemini-native analysis does not fit inside the MCP request's 60s, so
// analyze_video enqueues and this invocation does the work with its own budget.
//
// Two callers, same handler: the enqueuing request dispatches here immediately
// (the fast path), and the daily cron sweeper calls it after requeueing stuck
// rows (the backstop). Both authenticate with CRON_SECRET.
//
// Processes jobs until the time budget runs low rather than exactly one, so a
// backlog drains without waiting for N dispatches. It stops early and leaves
// the rest queued — the next dispatch or the next sweep continues.

import { analyzeVideoWithDownload } from '../../src/analysis/index.js';
import { claimNextJob, completeJob, failJob, type AnalyzeJobPayload } from '../../src/lib/jobs.js';
import { CREDIT_COSTS, refundCredits } from '../../src/lib/credits.js';

/**
 * Stop claiming new work with this much of the budget left.
 *
 * maxDuration is 60s (vercel.json). Claiming a job at 45s in would mean losing
 * it to the stuck-job sweeper 15 minutes later, having already charged an
 * attempt for work that never had time to run.
 */
const RESERVE_MS = 45_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (!authorized(req)) return json(401, { error: 'Unauthorized' });

  const startedAt = Date.now();
  const processed: Array<{ jobId: string; videoId: string; ok: boolean; error?: string }> = [];

  while (Date.now() - startedAt < RESERVE_MS) {
    const job = await claimNextJob('analyze');
    if (!job) break;

    let payload: AnalyzeJobPayload = {};
    try {
      payload = JSON.parse(job.payloadJson) as AnalyzeJobPayload;
    } catch {
      // A malformed payload is not worth failing the job over — the defaults
      // are what an un-parameterised analyze_video call would have used.
    }

    try {
      const result = await analyzeVideoWithDownload(job.videoId, {
        forceBackend: payload.forceBackend,
      });
      await completeJob(job.id, result.id ?? null);
      processed.push({ jobId: job.id, videoId: job.videoId, ok: true });
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);

      // The caller was debited at enqueue time, so the refund is owed here —
      // but only once the job has actually given up. A requeued job may still
      // succeed, and refunding then re-charging would corrupt the ledger.
      if (terminal && job.opId) {
        await refundCredits(
          job.workspaceId,
          CREDIT_COSTS.analyzeVideo,
          'analyze_video',
          `${job.opId}:fail`,
          'call_failed',
        ).catch(e => console.warn(`[jobs] refund failed for ${job.id}: ${(e as Error).message}`));
      }

      console.warn(`[jobs] analyze job ${job.id} failed (terminal=${terminal}): ${message}`);
      processed.push({ jobId: job.id, videoId: job.videoId, ok: false, error: message });
    }
  }

  return json(200, {
    processed: processed.length,
    succeeded: processed.filter(p => p.ok).length,
    failed: processed.filter(p => !p.ok).length,
    durationMs: Date.now() - startedAt,
    jobs: processed,
  });
}
