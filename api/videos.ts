// GET  /api/videos/:id?workspaceId=...            — video detail (analysis, playback URL, job status).
// POST /api/videos/:id/analyze { workspaceId, forceBackend? } — trigger AI analysis.
//
// One file, not two: the Hobby plan caps a deployment at 12 Serverless
// Functions (see api/sources.ts for the same constraint). vercel.json
// rewrites /api/videos/:id and /api/videos/:id/analyze onto this file with
// `id`/`action` query params — the URLs callers use are unchanged.
import { corsPreflight } from '../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../src/lib/authz.js';
import { getVideoDetailForWorkspace, analyzeVideoForWorkspace } from '../src/lib/video-service.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' });

  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const video = await getVideoDetailForWorkspace(auth.workspace, videoId);
  if (!video) return jsonResponse(404, { error: 'video_not_found' });
  return jsonResponse(200, video);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' });
  if (action !== 'analyze') return jsonResponse(404, { error: 'not_found' });

  let body: { workspaceId?: string; forceBackend?: string };
  try {
    body = (await request.json()) as { workspaceId?: string; forceBackend?: string };
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  const forceBackend = body.forceBackend === 'gemini-native' || body.forceBackend === 'gemini-text' ? body.forceBackend : undefined;
  const outcome = await analyzeVideoForWorkspace(auth.workspace, videoId, { forceBackend });

  if (!outcome.ok) {
    return jsonResponse(422, { error: 'analyze_failed', message: outcome.error, creditsCharged: outcome.creditsCharged, creditsRemaining: outcome.creditsRemaining });
  }

  if (outcome.queued) {
    return jsonResponse(200, {
      queued: true,
      jobId: outcome.job.id,
      status: outcome.job.status,
      backend: outcome.backend,
      creditsCharged: outcome.creditsCharged,
      creditsRemaining: outcome.creditsRemaining,
    });
  }

  return jsonResponse(200, {
    queued: false,
    analysisBasis: outcome.result.analysisBasis,
    backend: outcome.result.backend,
    model: outcome.result.model,
    analysis: outcome.result.analysis,
    creditsCharged: outcome.creditsCharged,
    creditsRemaining: outcome.creditsRemaining,
  });
}
