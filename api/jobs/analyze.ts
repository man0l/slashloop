// POST /api/jobs/analyze — drain analyze jobs off the request path.
//
// See docs/media-storage-plan.md §3.3 and src/lib/jobs.ts for why this exists:
// a gemini-native analysis does not fit inside the MCP request's 60s, so
// analyze_video enqueues and this invocation does the work with its own budget.
//
// Two callers, both authenticating with CRON_SECRET: the enqueuing request
// pokes it immediately (best-effort), and pg_cron pokes it every minute from
// inside Postgres (the reliable path).
//
// It reclaims abandoned claims itself rather than trusting a caller to have
// done so, which is what keeps the retry policy in one place.
//
// Processes jobs until the time budget runs low rather than exactly one, so a
// backlog drains without waiting for N dispatches. It stops early and leaves
// the rest queued — the next dispatch or the next sweep continues.

import { analyzeVideoWithDownload } from '../../src/analysis/index.js';
import { claimNextJob, completeJob, failJob, reclaimStuckJobs, type AnalyzeJobPayload } from '../../src/lib/jobs.js';
import { CREDIT_COSTS, refundCredits } from '../../src/lib/credits.js';
import { db } from '../../src/db.js';

/**
 * Stop claiming new work with this much of the budget left.
 *
 * maxDuration is 60s (vercel.json). Claiming a job at 45s in would mean losing
 * it to the stuck-job sweeper 15 minutes later, having already charged an
 * attempt for work that never had time to run.
 */
const RESERVE_MS = 45_000;

/**
 * Budget a refresh needs before it is worth starting.
 *
 * A scrape is one opaque, uninterruptible call. Started with less than this
 * left it gets killed mid-flight — billed, half-applied, and only recovered by
 * the stuck sweeper 15 minutes later. Better to leave the row queued for the
 * next drain a minute away.
 */
const REFRESH_MIN_BUDGET_MS = 30_000;

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

// Named method exports, not `export default handler`. That is what selects
// Vercel's Web-standard signature and hands us a real Request — the default
// export gets Node's (IncomingMessage, ServerResponse) instead, where `headers`
// is a plain object and `.get()` does not exist. Same convention as api/mcp.ts,
// api/stripe/webhook.ts and api/cron/media-retention.ts.
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'Unauthorized' });

  const startedAt = Date.now();
  const processed: Array<{ jobId: string; videoId: string | null; ok: boolean; error?: string }> = [];

  // Recover abandoned claims before taking new work. This is the single place
  // the retry policy is applied — the pg_cron job deliberately does not do it in
  // SQL, because a second copy of MAX_ATTEMPTS/STUCK_AFTER_MINUTES would drift
  // from these constants the first time one was tuned and the other wasn't.
  const reclaimed = await reclaimStuckJobs();

  while (Date.now() - startedAt < RESERVE_MS) {
    // Drain all three queues from this one endpoint so the existing pg_cron
    // schedule (which POSTs here every minute) picks them all up — no new
    // route. That is not just tidiness: the Hobby plan caps a deployment at 12
    // Serverless Functions, and this project is at the limit. A dedicated
    // /api/jobs/refresh route was written, hit the cap, and failed the build.
    //
    // refresh is claimed LAST because it is the longest job — a scrape can use
    // most of the budget on its own, and claiming one first would leave quick
    // analyze/fetch rows waiting a full minute for the next drain.
    const job = (await claimNextJob('fetch'))
      ?? (await claimNextJob('analyze'))
      ?? (await claimNextJob('refresh'));
    if (!job) break;

    // refresh jobs: scrape + persist + score a whole SOURCE. Credits are
    // pre-authorised and settled inside runRefresh, so these rows carry no
    // opId and the reclaim path has nothing to refund.
    if (job.kind === 'refresh') {
      if (!job.sourceId) {
        await failJob(job.id, 'refresh job has no sourceId');
        processed.push({ jobId: job.id, videoId: null, ok: false, error: 'no sourceId' });
        continue;
      }
      // Do not start a scrape that cannot finish. Unlike analyze, this call is
      // opaque and uninterruptible: begun with too little budget it is killed
      // mid-flight, which is the exact half-completion this queue exists to
      // prevent. Leave it queued for the next drain instead.
      if (Date.now() - startedAt > RESERVE_MS - REFRESH_MIN_BUDGET_MS) {
        await failJob(job.id, 'insufficient budget remaining; requeued for next drain');
        break;
      }
      try {
        const { runRefresh } = await import('../../src/lib/refresh.js');
        const result = await runRefresh({
          workspaceId: job.workspaceId,
          sourceId: job.sourceId,
          limitOverride: (JSON.parse(job.payloadJson || '{}') as { limitOverride?: number }).limitOverride,
        });
        if (!result.ok) {
          const message = result.errors.join('; ') || result.refusal || 'refresh refused';
          const { terminal } = await failJob(job.id, message);
          console.warn(`[jobs] refresh job ${job.id} refused (terminal=${terminal}): ${message}`);
          processed.push({ jobId: job.id, videoId: null, ok: false, error: message });
          continue;
        }
        await completeJob(job.id, null);
        processed.push({ jobId: job.id, videoId: null, ok: true });
      } catch (err) {
        const message = (err as Error).message;
        const { terminal } = await failJob(job.id, message);
        console.warn(`[jobs] refresh job ${job.id} failed (terminal=${terminal}): ${message}`);
        processed.push({ jobId: job.id, videoId: null, ok: false, error: message });
      }
      continue;
    }

    // Everything below is video-scoped. videoId is nullable on the row now that
    // source-scoped kinds share the table, so narrow it once here rather than
    // asserting at each use.
    const videoId = job.videoId;
    if (!videoId) {
      await failJob(job.id, `${job.kind} job has no videoId`);
      processed.push({ jobId: job.id, videoId: null, ok: false, error: 'no videoId' });
      continue;
    }

    // fetch jobs: download + store the MP4 only, no Gemini. Cost is Apify spend
    // (asserted inside downloadTikTokVideo), not AI credits, so these rows
    // carry no opId and reclaimStuckJobs never tries to refund them.
    if (job.kind === 'fetch') {
      try {
        const v = await db.video.findUnique({ where: { id: videoId }, select: { url: true, platform: true } });
        if (!v || v.platform !== 'tiktok' || !v.url) throw new Error('no downloadable TikTok URL');
        const { downloadAndStoreVideo } = await import('../../src/lib/media.js');
        const res = await downloadAndStoreVideo(job.workspaceId, videoId, v.url);
        if (!res) throw new Error('download/store returned no result');
        await completeJob(job.id, null);
        processed.push({ jobId: job.id, videoId, ok: true });
      } catch (err) {
        const message = (err as Error).message;
        const { terminal } = await failJob(job.id, message);
        console.warn(`[jobs] fetch job ${job.id} failed (terminal=${terminal}): ${message}`);
        processed.push({ jobId: job.id, videoId, ok: false, error: message });
      }
      continue;
    }

    let payload: AnalyzeJobPayload = {};
    try {
      payload = JSON.parse(job.payloadJson) as AnalyzeJobPayload;
    } catch {
      // A malformed payload is not worth failing the job over — the defaults
      // are what an un-parameterised analyze_video call would have used.
    }

    try {
      const result = await analyzeVideoWithDownload(videoId, {
        forceBackend: payload.forceBackend,
      });
      await completeJob(job.id, result.id ?? null);
      processed.push({ jobId: job.id, videoId, ok: true });
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
      processed.push({ jobId: job.id, videoId, ok: false, error: message });
    }
  }

  return json(200, {
    reclaimed,
    processed: processed.length,
    succeeded: processed.filter(p => p.ok).length,
    failed: processed.filter(p => !p.ok).length,
    durationMs: Date.now() - startedAt,
    jobs: processed,
  });
}

/** The queue is drained by POST only; a stray GET should say so, not 405-by-crash. */
export async function GET(): Promise<Response> {
  return json(405, { error: 'Method not allowed', hint: 'POST with Authorization: Bearer $CRON_SECRET' });
}
