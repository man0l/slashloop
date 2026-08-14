// ---------------------------------------------------------------------------
// Video-level AI analysis — shared by the analyze_video MCP tool
// (src/tools/video.ts) and the site's REST API (api/videos.ts), so neither
// surface duplicates the credit/queue/inline-vs-queued logic.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { analyzeVideoWithDownload } from '../analysis/index.js';
import type { AnalysisResult } from '../analysis/types.js';
import { loadAnalysisConfig } from '../analysis/config.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, creditBalance } from './credits.js';
import { resolveThumbUrl, signedMediaUrl } from './media.js';
import { slideshowImagesFromRaw } from './scrapers/tiktok-web.js';
import { enqueueAnalyzeJob, enqueueFetchJob, dispatchWorker, latestReportingJobForVideo, type MediaJobRow } from './jobs.js';
import { classifyGeminiError, errorCodeFor, parseJobLastError, friendlyGeminiMessage, type GeminiErrorCode } from './gemini-errors.js';

export type AnalyzeVideoOutcome =
  | { ok: true; queued: true; job: MediaJobRow; dispatched: boolean; dispatchReason?: string; backend: string; creditsCharged: number; creditsRemaining: number }
  | { ok: true; queued: false; result: AnalysisResult; creditsCharged: number; creditsRemaining: number }
  | {
      ok: false;
      /** Stable machine token — 'insufficient_credits' | 'not_found' | a
       *  GeminiErrorCode from gemini-errors.ts. Lets the REST layer pick an
       *  HTTP status + message without re-parsing an opaque sentence. */
      errorCode: string;
      error: string;
      /** For insufficient_credits: how many credits the action needed. */
      required?: number;
      creditsCharged: number;
      creditsRemaining: number;
    };

/**
 * Runs (or queues) analysis on one video. Mirrors the analyze_video MCP
 * tool's behavior exactly — same credit cost, same gemini-native-is-queued /
 * gemini-text-is-inline split (a native analysis needs an Apify download +
 * Gemini upload that together exceed any request's function-duration
 * budget; a text-only call finishes in seconds and stays inline). Returns
 * the raw job/result so each caller (MCP tool, REST endpoint) can shape its
 * own response — the MCP tool's conversational next-steps guidance and the
 * REST endpoint's plain JSON have different needs from the same underlying
 * work, so formatting stays with the caller.
 */
export async function analyzeVideoForWorkspace(
  workspace: Workspace,
  videoId: string,
  opts?: { forceBackend?: 'gemini-native' | 'gemini-text' | 'openrouter-video' },
): Promise<AnalyzeVideoOutcome> {
  const owned = await db.video.findFirst({ where: { id: videoId, source: { workspaceId: workspace.id } }, select: { id: true } });
  if (!owned) return { ok: false, errorCode: 'not_found', error: 'Video not found.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };

  const opId = randomUUID();
  try {
    await debitCredits(workspace.id, CREDIT_COSTS.analyzeVideo, 'analyze_video', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, errorCode: 'insufficient_credits', error: err.message, required: err.required, creditsCharged: 0, creditsRemaining: err.remaining };
    }
    throw err;
  }

  const effectiveBackend = opts?.forceBackend ?? (await loadAnalysisConfig(workspace.id)).backend;

  if (effectiveBackend === 'gemini-native' || effectiveBackend === 'openrouter-video') {
    // Check if the video is already stored — if so, skip the fetch phase and
    // enqueue the analyze job directly. Otherwise split into two queue steps:
    // a fetch job (download + store), then an analyze job (AI analysis on the
    // stored video). The fetch job handler chains the analyze job automatically.
    const videoInfo = await db.video.findUnique({ where: { id: videoId }, select: { mediaStatus: true } });
    const isStored = videoInfo?.mediaStatus === 'stored';

    let job: MediaJobRow;
    if (isStored) {
      job = await enqueueAnalyzeJob({ workspaceId: workspace.id, videoId, payload: { forceBackend: opts?.forceBackend }, opId });
    } else {
      job = await enqueueFetchJob({
        workspaceId: workspace.id,
        videoId,
        payload: {
          opId,
          enqueueAnalysis: { forceBackend: opts?.forceBackend },
        },
      });
    }

    const dispatch = await dispatchWorker();
    const balance = await creditBalance(workspace.id);
    return {
      ok: true, queued: true, job, dispatched: dispatch.dispatched, dispatchReason: dispatch.reason,
      backend: effectiveBackend, creditsCharged: CREDIT_COSTS.analyzeVideo, creditsRemaining: balance.total,
    };
  }

  try {
    const result = await analyzeVideoWithDownload(videoId, { forceBackend: opts?.forceBackend });
    const balance = await creditBalance(workspace.id);
    return { ok: true, queued: false, result, creditsCharged: CREDIT_COSTS.analyzeVideo, creditsRemaining: balance.total };
  } catch (err) {
    const balance = await refundCredits(workspace.id, CREDIT_COSTS.analyzeVideo, 'analyze_video', `${opId}:fail`, 'call_failed');
    // Classify so the REST layer can tell "Gemini out of credits" (429,
    // refunded, retry later) from "this video can't be analyzed" (422).
    const errorCode = errorCodeFor(classifyGeminiError(err).category);
    return { ok: false, errorCode, error: (err as Error).message, creditsCharged: 0, creditsRemaining: balance.total };
  }
}

export interface VideoDetailForWorkspace {
  id: string;
  thumbUrl: string | null;
  /** Signed playback URL — only set once the video is actually stored (see media-storage-plan.md). null until then. */
  mediaUrl: string | null;
  /** Photo-carousel URLs when the TikTok is a slideshow (no MP4). */
  slideshowImages: string[];
  creatorHandle: string;
  caption: string;
  views: number;
  outlierScore: number | null;
  analysis: {
    id: string;
    analysisBasis: string;
    backend: string;
    model: string;
    data: unknown;
  } | null;
  /** A queued/running analyze job (or a recent terminal failure with no newer
   *  successful analysis), so the caller can keep polling instead of assuming
   *  failure. errorCode is the machine tag ('gemini_quota', 'other', ...). */
  analysisJob: { jobId: string; status: string; lastError: string | null; errorCode: string | null } | null;
}

/**
 * Workspace-scoped video detail for the site's Gallery card: enough to
 * decide whether to show "Analyze", a queued/running state, or the finished
 * analysis + playable video. Deliberately narrower than the analyze_video
 * MCP tool's get_video (no hooks/ideas/recreation) — the card only needs
 * enough to render itself, not the full conversational surface.
 */
export async function getVideoDetailForWorkspace(workspace: Workspace, videoId: string): Promise<VideoDetailForWorkspace | null> {
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId: workspace.id } },
    include: {
      score: true,
      analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!video) return null;

  const latest = video.analyses[0];

  const [media, job] = await Promise.all([
    signedMediaUrl(video),
    latestReportingJobForVideo(video.id, { newerThan: latest?.createdAt }),
  ]);

  return {
    id: video.id,
    thumbUrl: resolveThumbUrl(video),
    mediaUrl: media.url,
    slideshowImages: slideshowImagesFromRaw(video.rawJson),
    creatorHandle: video.creatorHandle,
    caption: video.caption,
    views: video.views,
    outlierScore: video.score?.outlierScore ?? null,
    analysis: latest
      ? { id: latest.id, analysisBasis: latest.analysisBasis, backend: latest.backend, model: latest.model, data: JSON.parse(latest.analysisJson) }
      : null,
    analysisJob: job ? { jobId: job.id, status: job.status, lastError: job.lastError, errorCode: parseJobLastError(job.lastError)?.errorCode ?? null } : null,
  };
}

/**
 * Map an analyze outcome to an HTTP response, in one pure place so the route
 * (api/videos.ts) stays a thin shell and the mapping is unit-testable:
 *
 *   - not_found                  -> 404 video_not_found
 *   - insufficient_credits       -> 402 insufficient_credits (+ upgradeUrl)
 *   - Gemini quota/rate/5xx/timeout -> 429, retryable: true (paid API down —
 *                                    not the user's fault, nothing to fix)
 *   - any other failure          -> 422 analyze_failed
 *   - queued / inline success    -> 200
 *
 * 429 vs 422 is the whole point: the gallery can tell "Gemini ran out of
 * credits, come back later" (nothing charged) from "this video can't be
 * analyzed" without grepping an error string.
 */
export function mapAnalyzeOutcomeToHttp(outcome: AnalyzeVideoOutcome): { status: number; body: Record<string, unknown> } {
  if (!outcome.ok) {
    if (outcome.errorCode === 'not_found') {
      return { status: 404, body: { error: 'video_not_found' } };
    }
    if (outcome.errorCode === 'insufficient_credits') {
      const upgradeUrl = process.env.UPGRADE_URL ?? 'https://slashloop.dev/upgrade';
      return {
        status: 402,
        body: {
          error: 'insufficient_credits',
          required: outcome.required,
          remaining: outcome.creditsRemaining,
          upgradeUrl,
          message: outcome.error,
        },
      };
    }
    const transient = outcome.errorCode === 'gemini_quota'
      || outcome.errorCode === 'gemini_rate_limit'
      || outcome.errorCode === 'gemini_server'
      || outcome.errorCode === 'gemini_timeout';
    if (transient) {
      // Google-side capacity/credit trouble for the paid key — a 429 with
      // retryable:true says "nothing is wrong on your side, come back later".
      const publicError = outcome.errorCode === 'gemini_quota' ? 'gemini_quota_exhausted'
        : outcome.errorCode === 'gemini_rate_limit' ? 'gemini_rate_limited'
          : 'gemini_transient_error';
      return {
        status: 429,
        body: {
          error: publicError,
          retryable: true,
          errorCode: outcome.errorCode,
          message: friendlyGeminiMessage(outcome.errorCode as GeminiErrorCode),
          detail: outcome.error,
          creditsCharged: outcome.creditsCharged,
          creditsRemaining: outcome.creditsRemaining,
        },
      };
    }
    return {
      status: 422,
      body: {
        error: 'analyze_failed',
        errorCode: outcome.errorCode,
        message: friendlyGeminiMessage(outcome.errorCode as GeminiErrorCode, outcome.error),
        detail: outcome.error,
        creditsCharged: outcome.creditsCharged,
        creditsRemaining: outcome.creditsRemaining,
      },
    };
  }

  if (outcome.queued) {
    return {
      status: 200,
      body: {
        queued: true,
        jobId: outcome.job.id,
        status: outcome.job.status,
        backend: outcome.backend,
        creditsCharged: outcome.creditsCharged,
        creditsRemaining: outcome.creditsRemaining,
      },
    };
  }

  return {
    status: 200,
    body: {
      queued: false,
      analysisBasis: outcome.result.analysisBasis,
      backend: outcome.result.backend,
      model: outcome.result.model,
      analysis: outcome.result.analysis,
      creditsCharged: outcome.creditsCharged,
      creditsRemaining: outcome.creditsRemaining,
    },
  };
}
