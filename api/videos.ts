// GET   /api/videos/:id?workspaceId=...            — video detail (analysis, playback URL, job status).
// POST  /api/videos/:id/analyze { workspaceId, forceBackend? } — trigger AI analysis.
// POST  /api/videos/:id/fetch { workspaceId }      — queue a download-only fetch (store the MP4, no analysis, free).
// POST  /api/videos/:id/recreate { workspaceId }   — queue a cheap OpenRouter slideshow restage (2 credits).
//
// One file, not two: the Hobby plan caps a deployment at 12 Serverless
// Functions (see api/sources.ts for the same constraint) and this deployment
// is AT the cap. vercel.json rewrites all of these paths onto this file with
// `id`/`action` query params — the URLs callers use are unchanged.
import { corsPreflight } from '../src/lib/cors.js';
import { requireWorkspaceAccess, jsonResponse } from '../src/lib/authz.js';
import { getVideoDetailForWorkspace, analyzeVideoForWorkspace, fetchVideoForWorkspace, recreateSlideshowForWorkspace, mapAnalyzeOutcomeToHttp } from '../src/lib/video-service.js';
import { costBlock } from '../src/lib/next-steps.js';

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' }, request);

  const auth = await requireWorkspaceAccess(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const video = await getVideoDetailForWorkspace(auth.workspace, videoId);
  if (!video) return jsonResponse(404, { error: 'video_not_found' }, request);
  return jsonResponse(200, video, request);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' }, request);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, request);
  }

  const auth = await requireWorkspaceAccess(request, (body.workspaceId as string) ?? null);
  if (!auth.ok) return auth.response;

  if (action === 'analyze') {
    const forceBackend = body.forceBackend === 'gemini-native' || body.forceBackend === 'gemini-text' || body.forceBackend === 'openrouter-video' ? body.forceBackend : undefined;
    const outcome = await analyzeVideoForWorkspace(auth.workspace, videoId, { forceBackend });

    // All error/status shaping lives in the pure mapper so it's unit-testable —
    // insufficient credits -> 402, Gemini quota -> 429 retryable, other -> 422.
    const mapped = mapAnalyzeOutcomeToHttp(outcome);
    return jsonResponse(mapped.status, mapped.body, request);
  }

  if (action === 'recreate') {
    const outcome = await recreateSlideshowForWorkspace(auth.workspace, videoId);
    if (!outcome.ok) {
      if (outcome.errorCode === 'not_found') return jsonResponse(404, { error: 'video_not_found' }, request);
      if (outcome.errorCode === 'insufficient_credits') {
        return jsonResponse(402, {
          error: 'insufficient_credits',
          message: outcome.error,
          required: outcome.required,
          remaining: outcome.creditsRemaining,
          upgradeUrl: process.env.UPGRADE_URL ?? 'https://slashloop.dev/upgrade',
        }, request);
      }
      return jsonResponse(422, { error: outcome.errorCode, message: outcome.error }, request);
    }
    if ('alreadyStored' in outcome && outcome.alreadyStored) {
      return jsonResponse(200, { alreadyStored: true, recreationImages: outcome.recreationImages }, request);
    }
    if ('job' in outcome) {
      return jsonResponse(200, {
        queued: true,
        jobId: outcome.job.id,
        status: outcome.job.status,
        creditsCharged: outcome.creditsCharged,
        creditsRemaining: outcome.creditsRemaining,
        ...costBlock(outcome.creditsRemaining),
      }, request);
    }
    return jsonResponse(500, { error: 'unexpected_recreate_outcome' }, request);
  }

  if (action === 'fetch') {
    // Download-only: queue a fetch job (or reuse the outstanding one) with
    // no analysis chained and no credits involved. Poll GET detail until
    // mediaUrl appears; a failed fetch surfaces via analysisJob like any job.
    const outcome = await fetchVideoForWorkspace(auth.workspace, videoId);
    if (!outcome.ok) return jsonResponse(404, { error: 'video_not_found' }, request);
    if (outcome.alreadyStored) return jsonResponse(200, { alreadyStored: true }, request);
    return jsonResponse(200, { queued: true, jobId: outcome.job.id, status: outcome.job.status }, request);
  }

  return jsonResponse(404, { error: 'not_found' }, request);
}
