// ---------------------------------------------------------------------------
// processClaimedJob — the per-job processing switch, shared by every worker.
//
// This is the queue-drain logic that used to live inline inside
// api/jobs/analyze.ts (the Vercel HTTP worker). Extracted so a long-running
// VPS/Bun worker (src/worker/index.ts) can call the exact same code with NO
// time budget, while the Vercel worker keeps its 45s-invocation reserve. The
// retry/refund policy stays in exactly one place here.
//
// Contract: the caller has already CLAIMED the job (status running, attempts+1).
// This function either completes it, fails it (requeue or terminal), or — for
// a refresh job that can't fit the caller's remaining budget — returns
// `{ ok: false, requeued: true }` so the caller can stop claiming.
// ---------------------------------------------------------------------------

import { analyzeVideoWithDownload } from '../analysis/index.js';
import {
  claimNextJob, completeJob, failJob, enqueueAnalyzeJob,
  type MediaJobRow, type AnalyzeJobPayload, type FetchJobPayload,
} from '../lib/jobs.js';
import { CREDIT_COSTS, refundCredits } from '../lib/credits.js';
import { tagJobFailure } from '../lib/gemini-errors.js';
import { db } from '../db.js';

export interface JobProcessOptions {
  /**
   * If set, a refresh job is only started when it can finish before this
   * wall-clock deadline (ms epoch). The Vercel worker passes its invocation
   * deadline; the VPS loop omits it, so refresh always runs there.
   */
  deadlineMs?: number;
  /** Minimum budget a refresh job needs before it is worth starting. */
  refreshRequiresMs?: number;
}

export interface JobProcessResult {
  ok: boolean;
  error?: string;
  /** True when the job was left queued because the caller ran out of budget. */
  requeued?: boolean;
}

const DEFAULT_REFRESH_REQUIRES_MS = 30_000;

export async function processClaimedJob(
  job: MediaJobRow,
  opts?: JobProcessOptions,
): Promise<JobProcessResult> {
  // rescore jobs: recompute scores for every source holding a creator's videos.
  // Split out of runRefresh because it was the step that kept dying — it ran
  // with ~11s of budget left after a 48s scrape. No Apify, no credits, so a
  // retry is free.
  if (job.kind === 'rescore') {
    try {
      const { creatorHandle } = JSON.parse(job.payloadJson || '{}') as { creatorHandle?: string };
      const { batchScoreVideos } = await import('../scoring.js');

      if (creatorHandle) {
        // Creator-scoped: every source holding their videos.
        const rows = await db.video.findMany({
          where: { creatorHandle, source: { workspaceId: job.workspaceId } },
          select: { sourceId: true },
          distinct: ['sourceId'],
        });
        for (const r of rows) await batchScoreVideos(r.sourceId);
      } else {
        // Source-scoped: one source only. This is how a whole-workspace rescore
        // is split — one job per source — so no single invocation has to score
        // every video in the workspace. Doing that inline timed out at ~450
        // videos and applied only partially.
        if (!job.sourceId) throw new Error('rescore job has neither creatorHandle nor sourceId');
        await batchScoreVideos(job.sourceId);
      }
      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);
      console.warn(`[worker] rescore job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // refresh jobs: scrape + persist + score a whole SOURCE. Credits are
  // pre-authorised and settled inside runRefresh, so these rows carry no opId
  // and the reclaim path has nothing to refund.
  if (job.kind === 'refresh') {
    if (!job.sourceId) {
      await failJob(job.id, 'refresh job has no sourceId');
      return { ok: false, error: 'no sourceId' };
    }
    // Do not start a scrape that cannot finish. Unlike analyze, this call is
    // opaque and uninterruptible: begun with too little budget it is killed
    // mid-flight, which is the exact half-completion this queue exists to
    // prevent. Leave it queued for the next drain instead.
    const requires = opts?.refreshRequiresMs ?? DEFAULT_REFRESH_REQUIRES_MS;
    if (opts?.deadlineMs && Date.now() + requires > opts.deadlineMs) {
      await failJob(job.id, 'insufficient budget remaining; requeued for next drain');
      return { ok: false, error: 'insufficient budget remaining; requeued for next drain', requeued: true };
    }
    try {
      const { runRefresh } = await import('../lib/refresh.js');
      const result = await runRefresh({
        workspaceId: job.workspaceId,
        sourceId: job.sourceId,
        limitOverride: (JSON.parse(job.payloadJson || '{}') as { limitOverride?: number }).limitOverride,
        // Stable across every retry of this job (minted once at enqueue) — see
        // the opId doc comment in src/lib/refresh.ts.
        opId: job.opId ?? undefined,
        preAuthCredits: job.preAuthCredits ?? undefined,
      });
      if (!result.ok) {
        const message = result.errors.join('; ') || result.refusal || 'refresh refused';
        const { terminal } = await failJob(job.id, message);
        console.warn(`[worker] refresh job ${job.id} refused (terminal=${terminal}): ${message}`);
        return { ok: false, error: message };
      }
      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);
      console.warn(`[worker] refresh job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // Everything below is video-scoped. videoId is nullable on the row now that
  // source-scoped kinds share the table, so narrow it once here rather than
  // asserting at each use.
  const videoId = job.videoId;
  if (!videoId) {
    await failJob(job.id, `${job.kind} job has no videoId`);
    return { ok: false, error: 'no videoId' };
  }

  // fetch jobs: download + store the MP4 only, no Gemini. Cost is Apify spend
  // (asserted inside downloadTikTokVideo), not AI credits, so these rows carry
  // no opId and reclaimStuckJobs never tries to refund them — unless the fetch
  // was enqueued as part of an analysis pipeline, in which case the payload
  // carries an opId for credit refund on failure, and an enqueueAnalysis block
  // to chain an analyze job after successful store.
  if (job.kind === 'fetch') {
    try {
      const v = await db.video.findUnique({ where: { id: videoId }, select: { url: true, platform: true } });
      if (!v || v.platform !== 'tiktok' || !v.url) throw new Error('no downloadable TikTok URL');
      const { downloadAndStoreVideo } = await import('../lib/media.js');
      // Throws (and marks the video mediaStatus='failed') on any failure with
      // the REAL Apify reason — that message becomes this job's lastError,
      // which the gallery's ⛔ fetch-error surface maps to a specific issue
      // (spend cap, actor, CDN, deleted video...).
      await downloadAndStoreVideo(job.workspaceId, videoId, v.url);

      // If this fetch was a precursor to analysis, enqueue the analyze job now
      // that the video is stored. The analyze job will use the stored MP4 (URL
      // mode for openrouter-video, or Phase 2.1 cache) instead of downloading
      // from Apify again.
      const fPayload = JSON.parse(job.payloadJson || '{}') as FetchJobPayload;
      if (fPayload.enqueueAnalysis && job.opId) {
        // The fetch job's payload came from the API, so the backend string is
        // only trusted if it matches a real analyzer — narrow before handing
        // it to enqueueAnalyzeJob, whose payload type is the closed union.
        const fb = fPayload.enqueueAnalysis.forceBackend;
        await enqueueAnalyzeJob({
          workspaceId: job.workspaceId,
          videoId,
          payload: { forceBackend: fb === 'gemini-native' || fb === 'gemini-text' || fb === 'openrouter-video' ? fb : undefined },
          opId: job.opId,
        });
      }

      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);

      // If the fetch had a pending analysis, refund the pre-debited credits
      // since the analysis will never run. Only refund on terminal failure
      // (attempts exhausted) — a retry may still succeed.
      if (terminal) {
        const fPayload = JSON.parse(job.payloadJson || '{}') as FetchJobPayload;
        if (fPayload.opId) {
          await refundCredits(
            job.workspaceId,
            CREDIT_COSTS.analyzeVideo,
            'analyze_video',
            `${fPayload.opId}:fetch_fail`,
            'fetch_failed',
          ).catch(e => console.warn(`[worker] refund failed for fetch ${job.id}: ${(e as Error).message}`));
        }
      }

      console.warn(`[worker] fetch job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // analyze jobs (the default kind): the full AI analysis pipeline.
  let payload: AnalyzeJobPayload = {};
  try {
    payload = JSON.parse(job.payloadJson) as AnalyzeJobPayload;
  } catch {
    // A malformed payload is not worth failing the job over — the defaults are
    // what an un-parameterised analyze_video call would have used.
  }

  try {
    const result = await analyzeVideoWithDownload(videoId, {
      forceBackend: payload.forceBackend,
    });
    await completeJob(job.id, result.id ?? null);
    return { ok: true };
  } catch (err) {
    // Tag the failure with its category ([gemini_quota] etc.) so the detail
    // endpoint can tell the gallery "Gemini is out of credits" from "this
    // video can't be analyzed" — see src/lib/gemini-errors.ts.
    const message = tagJobFailure(err);
    const { terminal } = await failJob(job.id, message);

    // The caller was debited at enqueue time, so the refund is owed here — but
    // only once the job has actually given up. A requeued job may still
    // succeed, and refunding then re-charging would corrupt the ledger.
    if (terminal && job.opId) {
      await refundCredits(
        job.workspaceId,
        CREDIT_COSTS.analyzeVideo,
        'analyze_video',
        `${job.opId}:fail`,
        'call_failed',
      ).catch(e => console.warn(`[worker] refund failed for ${job.id}: ${(e as Error).message}`));
    }

    console.warn(`[worker] analyze job ${job.id} failed (terminal=${terminal}): ${message}`);
    return { ok: false, error: message };
  }
}