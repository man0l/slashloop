// SLA-868: the request-path half of the composite source. Light by design: it
// decides whether a video is a photo-annotation source, whether its deck is
// ready, and otherwise queues the VPS job that renders it. No rendering here.
import type { Video } from '@prisma/client';
import { db } from '../../db.js';
import { enqueueCompositeDeckJob } from '../../lib/jobs.js';
import { hasExperimentSlides, isPhotoPost } from '../../lib/media.js';
import { ExperimentError, TERMINAL_STATUSES } from '../schema.js';
import * as store from '../store.js';
import { detectAnnotationPattern } from './deck.js';
import { compositeDeckOf, deckFingerprint, type DeckRequest } from './options.js';

export interface DeckJob { id: string; status: string; lastError: string | null }

export interface CompositeResolveDeps {
  latestAnalysisJson(videoId: string): Promise<unknown | null>;
  /** Ids of experiments that still read this video's slides. */
  activeExperimentIds(workspaceId: string, videoId: string): Promise<string[]>;
  latestDeckJob(videoId: string, fingerprint: string): Promise<DeckJob | null>;
  enqueue(workspaceId: string, videoId: string, fingerprint: string, request: DeckRequest, dedupeKey: string): Promise<{ id: string }>;
}

export const liveResolveDeps: CompositeResolveDeps = {
  async latestAnalysisJson(videoId) {
    const row = await db.analysis.findFirst({ where: { videoId }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } });
    if (!row?.analysisJson) return null;
    try { return JSON.parse(row.analysisJson); } catch { return null; }
  },
  async activeExperimentIds(workspaceId, videoId) {
    const terminal = new Set<string>(TERMINAL_STATUSES);
    const all = await store.list(workspaceId, 50);
    return all.filter(e => !terminal.has(e.status) && e.inputs.some(i => i.videoId === videoId)).map(e => e.id);
  },
  async latestDeckJob(videoId, fingerprint) {
    const row = await db.mediaJob.findFirst({
      where: { videoId, kind: 'recreate', payloadJson: { contains: `"fingerprint":"${fingerprint}"` } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, lastError: true },
    });
    return row;
  },
  enqueue: (workspaceId, videoId, fingerprint, request, dedupeKey) =>
    enqueueCompositeDeckJob({ workspaceId, videoId, fingerprint, request, dedupeKey }),
};

const RUNNING = new Set(['queued', 'running', 'queued_remote']);

/**
 * Returns the video unchanged when it needs no composite deck (a photo post, a
 * video with an AI Recreate deck, or a video that is not a photo-annotation
 * source) or when its composite deck already matches the request. Otherwise
 * queues the render and throws `composite_deck_pending`, so the caller repeats
 * the same create once the job is done.
 */
export async function resolveCompositeSource(
  workspaceId: string, video: Video, req: DeckRequest, deps: CompositeResolveDeps = liveResolveDeps,
): Promise<Video> {
  if (isPhotoPost(video)) return video;
  const stamp = compositeDeckOf(video.rawJson);
  if (hasExperimentSlides(video.rawJson) && !stamp) return video;
  const pattern = detectAnnotationPattern(await deps.latestAnalysisJson(video.id));
  if (!pattern) return video;

  const fingerprint = deckFingerprint(video.id, req);
  if (stamp?.fingerprint === fingerprint) return video;

  if (stamp) {
    const active = await deps.activeExperimentIds(workspaceId, video.id);
    if (active.length) {
      throw new ExperimentError(409, 'composite_deck_in_use',
        `This video's composite deck is the source of unfinished experiment(s) ${active.slice(0, 3).join(', ')}; a different deck would replace their slides. Cancel or finish them first.`);
    }
  }
  const latest = await deps.latestDeckJob(video.id, fingerprint);
  if (latest && RUNNING.has(latest.status)) throw pendingDeck(latest.id);
  const job = await deps.enqueue(workspaceId, video.id, fingerprint, req, `composite:${video.id}:${fingerprint}:${latest?.id ?? 'first'}`);
  throw pendingDeck(job.id, latest?.status === 'failed' ? latest.lastError : null);
}

function pendingDeck(jobId: string, previousError?: string | null) {
  return new ExperimentError(409, 'composite_deck_pending',
    `Rendering the photo-annotation deck for this video (job ${jobId}). It is code-rendered: no image credits are charged. `
    + `Wait for the job (await_job / get_job_status), then repeat this exact create_experiment call.${previousError ? ` The previous attempt failed: ${previousError}` : ''}`);
}
