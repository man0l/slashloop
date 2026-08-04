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
import { enqueueAnalyzeJob, dispatchWorker, outstandingJobForVideo, type MediaJobRow } from './jobs.js';

export type AnalyzeVideoOutcome =
  | { ok: true; queued: true; job: MediaJobRow; dispatched: boolean; dispatchReason?: string; backend: string; creditsCharged: number; creditsRemaining: number }
  | { ok: true; queued: false; result: AnalysisResult; creditsCharged: number; creditsRemaining: number }
  | { ok: false; error: string; creditsCharged: number; creditsRemaining: number };

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
  opts?: { forceBackend?: 'gemini-native' | 'gemini-text' },
): Promise<AnalyzeVideoOutcome> {
  const owned = await db.video.findFirst({ where: { id: videoId, source: { workspaceId: workspace.id } }, select: { id: true } });
  if (!owned) return { ok: false, error: 'Video not found.', creditsCharged: 0, creditsRemaining: (await creditBalance(workspace.id)).total };

  const opId = randomUUID();
  try {
    await debitCredits(workspace.id, CREDIT_COSTS.analyzeVideo, 'analyze_video', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, error: err.message, creditsCharged: 0, creditsRemaining: err.remaining };
    }
    throw err;
  }

  const effectiveBackend = opts?.forceBackend ?? (await loadAnalysisConfig(workspace.id)).backend;

  if (effectiveBackend === 'gemini-native') {
    const job = await enqueueAnalyzeJob({ workspaceId: workspace.id, videoId, payload: { forceBackend: opts?.forceBackend }, opId });
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
    return { ok: false, error: (err as Error).message, creditsCharged: 0, creditsRemaining: balance.total };
  }
}

export interface VideoDetailForWorkspace {
  id: string;
  thumbUrl: string | null;
  /** Signed playback URL — only set once the video is actually stored (see media-storage-plan.md). null until then. */
  mediaUrl: string | null;
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
  /** A queued/running analyze job for this video, so the caller can keep polling instead of assuming failure. */
  analysisJob: { jobId: string; status: string; lastError: string | null } | null;
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

  const [media, job] = await Promise.all([
    signedMediaUrl(video),
    outstandingJobForVideo(video.id),
  ]);

  const latest = video.analyses[0];

  return {
    id: video.id,
    thumbUrl: resolveThumbUrl(video),
    mediaUrl: media.url,
    creatorHandle: video.creatorHandle,
    caption: video.caption,
    views: video.views,
    outlierScore: video.score?.outlierScore ?? null,
    analysis: latest
      ? { id: latest.id, analysisBasis: latest.analysisBasis, backend: latest.backend, model: latest.model, data: JSON.parse(latest.analysisJson) }
      : null,
    analysisJob: job ? { jobId: job.id, status: job.status, lastError: job.lastError } : null,
  };
}
