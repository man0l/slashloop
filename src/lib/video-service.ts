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
import { resolveThumbUrl, signedMediaUrl, resolveSlideshowUrls, resolveRecreationUrls, isPhotoPost, slideshowIsHydrated } from './media.js';
import { enqueueAnalyzeJob, enqueueFetchJob, enqueueRecreateJob, latestReportingJobForVideo, outstandingJobForVideo, latestJobForVideo, type MediaJobRow } from './jobs.js';
import { classifyGeminiError, errorCodeFor, parseJobLastError, friendlyGeminiMessage, type GeminiErrorCode } from './gemini-errors.js';
import { keepAlive } from '../cf/wait-until.js';
import { driveVideoRecreateJob, defaultRecreateVideoDeps, recreatePreAuthCredits } from './recreate-video-stream.js';
import { MAX_VIDEO_SLIDES, MAX_RECREATE_SLIDES } from './recreate-slideshow.js';

export type AnalyzeVideoOutcome =
  | { ok: true; queued: true; job: MediaJobRow; backend: string; creditsCharged: number; creditsRemaining: number }
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
  const videoInfo = await db.video.findUnique({
    where: { id: videoId },
    select: { mediaStatus: true, rawJson: true, durationSec: true, thumbnailUrl: true },
  });
  const photo = videoInfo ? isPhotoPost(videoInfo) : false;

  if (photo || effectiveBackend === 'gemini-native' || effectiveBackend === 'openrouter-video') {
    // Check if the video is already stored — if so, skip the fetch phase and
    // enqueue the analyze job directly. Otherwise split into two queue steps:
    // a fetch job (download + store), then an analyze job (AI analysis on the
    // stored video). The fetch job handler chains the analyze job automatically.
    // Photo posts: 'slideshow' is stored (every slide in R2). Analyze with
    // gemini-text so the model sees each slide, not an MP4 that does not exist.
    const slidesReady = photo && slideshowIsHydrated(videoInfo?.rawJson);
    const isStored = videoInfo?.mediaStatus === 'stored' || slidesReady;
    const photoBackend = photo ? 'gemini-text' as const : opts?.forceBackend;

    let job: MediaJobRow;
    if (isStored) {
      job = await enqueueAnalyzeJob({ workspaceId: workspace.id, videoId, payload: { forceBackend: photoBackend }, opId });
    } else {
      job = await enqueueFetchJob({
        workspaceId: workspace.id,
        videoId,
        payload: {
          opId,
          enqueueAnalysis: { forceBackend: photoBackend },
        },
      });
    }

    const balance = await creditBalance(workspace.id);
    return {
      ok: true, queued: true, job,
      backend: photo ? 'gemini-text' : effectiveBackend, creditsCharged: CREDIT_COSTS.analyzeVideo, creditsRemaining: balance.total,
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

export type FetchVideoOutcome =
  | { ok: true; alreadyStored: true }
  | { ok: true; alreadyStored?: false; queued: true; job: MediaJobRow }
  | { ok: false; errorCode: 'not_found'; error: string };

/**
 * Queue a download-only fetch for one video — the MP4 is downloaded and
 * stored, with NO AI analysis chained (contrast analyzeVideoForWorkspace,
 * whose fetch job carries enqueueAnalysis). Free: no credit pre-auth, no
 * opId, so reclaimStuckJobs never tries to refund these rows. A second call
 * while a fetch is outstanding returns the existing job instead of queueing
 * a duplicate; an already-stored video short-circuits without queueing.
 */
export async function fetchVideoForWorkspace(
  workspace: Workspace,
  videoId: string,
): Promise<FetchVideoOutcome> {
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId: workspace.id } },
    select: { id: true, mediaStatus: true, durationSec: true, rawJson: true, thumbnailUrl: true },
  });
  if (!video) return { ok: false, errorCode: 'not_found', error: 'Video not found.' };
  if (video.mediaStatus === 'stored') return { ok: true, alreadyStored: true };
  if (slideshowIsHydrated(video.rawJson)) return { ok: true, alreadyStored: true };
  // Photo posts have no MP4. Queue the same fetch job as videos — the worker
  // hits the watch page (imagePost) and persists every slide. Do not ingest
  // the photomode cover here and call that done: item_list usually omits
  // the rest of the carousel.

  const outstanding = await outstandingJobForVideo(videoId);
  if (outstanding && (outstanding.status === 'queued' || outstanding.status === 'running')) {
    return { ok: true, queued: true, job: outstanding };
  }

  const job = await enqueueFetchJob({ workspaceId: workspace.id, videoId, payload: {} });
  return { ok: true, queued: true, job };
}

export interface VideoDetailForWorkspace {
  id: string;
  thumbUrl: string | null;
  /** Signed playback URL — only set once the video is actually stored (see media-storage-plan.md). null until then. */
  mediaUrl: string | null;
  /** Photo-carousel URLs when the TikTok is a slideshow (no MP4). */
  slideshowImages: string[];
  /** AI-recreated carousel URLs (OpenRouter gpt-image-2.5-sunburst). */
  recreationImages: string[];
  /** True when this TikTok is a photo post — never offer MP4 download. */
  isSlideshow: boolean;
  recreateJob: { jobId: string; status: string; lastError: string | null } | null;
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
  // Sequential finds instead of a multi-relation `include`: Prisma's D1
  // adapter fans nested reads into concurrent prepared statements, which
  // hang the binding on Workers (same hang class as the `_count` includes
  // removed from the sources list). Shape of the returned object is unchanged.
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId: workspace.id } },
  });
  if (!video) return null;

  const analyses = await db.analysis.findMany({
    where: { videoId: video.id },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  const latest = analyses[0] ?? null;

  const score = await db.score.findUnique({ where: { videoId: video.id } });

  // Sequential too: signedMediaUrl is storage-only, but keeping one await
  // in flight keeps this handler's D1 usage trivially wedge-proof.
  const photo = isPhotoPost(video);
  const media = photo ? { url: null as string | null } : await signedMediaUrl(video);
  const job = await latestReportingJobForVideo(video.id, { newerThan: latest?.createdAt });
  const recreateJob = await latestJobForVideo(video.id, 'recreate');
  const recreationImages = resolveRecreationUrls(video.rawJson);

  return {
    id: video.id,
    thumbUrl: resolveThumbUrl(video),
    mediaUrl: media.url,
    slideshowImages: resolveSlideshowUrls(video.rawJson),
    recreationImages,
    isSlideshow: photo,
    recreateJob: recreateJob && (recreateJob.status === 'queued' || recreateJob.status === 'running' || (recreateJob.status === 'failed' && !recreationImages.length))
      ? { jobId: recreateJob.id, status: recreateJob.status, lastError: recreateJob.lastError }
      : null,
    creatorHandle: video.creatorHandle,
    caption: video.caption,
    views: video.views,
    outlierScore: score?.outlierScore ?? null,
    analysis: latest
      ? { id: latest.id, analysisBasis: latest.analysisBasis, backend: latest.backend, model: latest.model, data: JSON.parse(latest.analysisJson) }
      : null,
    analysisJob: job ? { jobId: job.id, status: job.status, lastError: job.lastError, errorCode: parseJobLastError(job.lastError)?.errorCode ?? null } : null,
  };
}

export type RecreateSlideshowOutcome =
  | { ok: true; alreadyStored: true; recreationImages: string[] }
  | { ok: true; queued: true; job: MediaJobRow; creditsCharged: number; creditsRemaining: number }
  | { ok: false; errorCode: string; error: string; creditsCharged: number; creditsRemaining: number; required?: number };

export async function recreateSlideshowForWorkspace(
  workspace: Workspace,
  videoId: string,
): Promise<RecreateSlideshowOutcome> {
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId: workspace.id } },
    select: { id: true, rawJson: true, mediaStatus: true, mediaKey: true, durationSec: true, thumbnailUrl: true },
  });
  if (!video) return { ok: false, errorCode: 'not_found', error: 'Video not found.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };
  if (isPhotoPost(video)) {
    if (!resolveSlideshowUrls(video.rawJson).length) {
      return { ok: false, errorCode: 'no_slides', error: 'Download the original slides first.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };
    }
  } else if (!video.mediaKey) {
    return { ok: false, errorCode: 'no_media', error: 'Download the video first, then recreate it as a slideshow.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, errorCode: 'not_configured', error: 'OPENROUTER_API_KEY is not configured.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };
  }

  const outstanding = await latestJobForVideo(videoId, 'recreate');
  if (outstanding && (outstanding.status === 'queued' || outstanding.status === 'running')) {
    return { ok: true, queued: true, job: outstanding, creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };
  }

  const opId = randomUUID();
  // Per-slide pricing: photo decks know their slide count up front (exact
  // debit); video decks plan later, so pre-auth the max and let the driver
  // true-up refund the difference once the plan lands.
  const isPhoto = isPhotoPost(video);
  const slideCount = isPhoto
    ? Math.min(Math.max(resolveSlideshowUrls(video.rawJson).length, 1), MAX_RECREATE_SLIDES)
    : MAX_VIDEO_SLIDES;
  const preAuthCredits = recreatePreAuthCredits(slideCount);
  try {
    await debitCredits(workspace.id, preAuthCredits, 'recreate_slideshow', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, errorCode: 'insufficient_credits', error: err.message, required: err.required, creditsCharged: 0, creditsRemaining: err.remaining };
    }
    throw err;
  }

  const job = await enqueueRecreateJob({
    workspaceId: workspace.id,
    videoId,
    opId,
    preAuthCredits,
    payload: { mode: isPhoto ? 'photo' : 'video' },
  });
  // Instant start on the Worker: drive the whole pipeline in this request's
  // background instead of waiting for the next */2 tick (the cron remains the
  // resume net). The claim marks the row running AND seeds the stepAt lease —
  // otherwise the cron's resume path sees a stale-lease running row and a
  // second drive races this one (double plan calls, duplicated keys). No-op
  // off the Worker (keepAlive returns false on Node).
  if (!isPhotoPost(video)) keepAlive(
    (async () => {
      const claimed = await db.mediaJob.update({
        where: { id: job.id },
        data: {
          status: 'running',
          startedAt: new Date(),
          attempts: { increment: 1 },
          payloadJson: JSON.stringify({ mode: isPhotoPost(video) ? 'photo' : 'video', stepAt: Date.now() }),
        },
      });
      await driveVideoRecreateJob(
        claimed as unknown as Parameters<typeof driveVideoRecreateJob>[0],
        defaultRecreateVideoDeps(),
        Date.now() + 600_000,
      );
    })().catch((err: unknown) => console.warn(`[recreate] enqueue drive failed for ${videoId} (cron resumes): ${(err as Error).message}`)),
  );
  const balance = await creditBalance(workspace.id);
  return { ok: true, queued: true, job, creditsCharged: preAuthCredits, creditsRemaining: balance.total };
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
