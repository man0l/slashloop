// GET    /api/sources?workspaceId=...              — list sources for a workspace the caller owns.
// POST   /api/sources { workspaceId, ... }          — create a source.
// GET    /api/sources/:id?workspaceId=...           — a single source.
// PATCH  /api/sources/:id { workspaceId, ... }       — update a source.
// DELETE /api/sources/:id?workspaceId=...           — delete a source.
// POST   /api/sources/:id/refresh { workspaceId }   — queue a refresh.
//
// One file, not four: the Hobby plan caps a deployment at 12 Serverless
// Functions (see api/jobs/analyze.ts for the same constraint hitting the job
// queue). vercel.json rewrites /api/sources/:id and /api/sources/:id/refresh
// onto this file with `id`/`action` query params — the URLs callers use are
// unchanged, only the physical function count drops.
import { corsPreflight } from '../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../src/lib/authz.js';
import {
  listSourcesForWorkspace,
  createSourceForWorkspace,
  getSourceForWorkspace,
  updateSourceForWorkspace,
  deleteSourceForWorkspace,
  refreshSourceForWorkspace,
} from '../src/lib/sources-service.js';
import { suggestSourcesForWorkspace } from '../src/lib/suggestions.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

interface CreateSourceBody {
  workspaceId?: string;
  platform?: string;
  sourceType?: string;
  query?: string;
  language?: string;
  videoLimit?: number;
  refreshSchedule?: string;
  nicheTag?: string;
}

interface UpdateSourceBody {
  workspaceId?: string;
  query?: string;
  videoLimit?: number;
  refreshSchedule?: string;
  isActive?: boolean;
  nicheTag?: string | null;
  language?: string;
}

interface RefreshBody {
  workspaceId?: string;
  videoLimit?: number;
}

const SOURCE_TYPES = new Set(['creator', 'keyword', 'hashtag']);
const REFRESH_SCHEDULES = new Set(['manual', 'daily', 'weekly']);

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('id');

  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  if (sourceId) {
    const source = await getSourceForWorkspace(auth.workspace, sourceId);
    if (!source) return jsonResponse(404, { error: 'source_not_found' });
    return jsonResponse(200, source);
  }

  const sources = await listSourcesForWorkspace(auth.workspace, {
    platform: url.searchParams.get('platform') ?? undefined,
    sourceType: url.searchParams.get('sourceType') ?? undefined,
    isActive: url.searchParams.has('isActive') ? url.searchParams.get('isActive') === 'true' : undefined,
    nicheTag: url.searchParams.get('nicheTag') ?? undefined,
  });
  return jsonResponse(200, sources);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('id');
  const action = url.searchParams.get('action');

  if (sourceId && action === 'refresh') {
    let body: RefreshBody;
    try {
      body = (await request.json()) as RefreshBody;
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
    if (!auth.ok) return auth.response;

    // The web UI never wants to block on an inline scrape — always queue.
    const result = await refreshSourceForWorkspace(auth.workspace, sourceId, { videoLimit: body.videoLimit, async: true });

    switch (result.kind) {
      case 'not_found':
        return jsonResponse(404, { error: 'source_not_found' });
      case 'already_queued':
        return jsonResponse(200, { message: 'Refresh already queued', jobId: result.jobId, status: result.status, sourceId: result.sourceId });
      case 'queued':
        return jsonResponse(200, {
          message: `Refresh queued for ${result.query}`,
          jobId: result.jobId,
          sourceId: result.sourceId,
          videoLimit: result.videoLimit,
          deadlineAt: result.deadlineAt,
          workerDispatched: result.workerDispatched,
        });
      case 'cap_breached':
        return jsonResponse(429, { error: 'apify_spend_cap_breached', capStatus: result.capStatus });
      case 'insufficient_credits':
        return jsonResponse(402, { error: 'insufficient_credits', message: result.err.message });
      case 'spend_cap_exceeded':
        return jsonResponse(429, { error: 'apify_spend_cap_exceeded', message: result.message, creditsRemaining: result.creditsRemaining });
      case 'done':
        // Only reachable if async:true is ever overridden to false — kept for
        // type completeness, since refreshSourceForWorkspace always queues here.
        return jsonResponse(200, result);
    }
  }

  if (action === 'suggest') {
    let body: { workspaceId?: string };
    try {
      body = (await request.json()) as { workspaceId?: string };
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
    if (!auth.ok) return auth.response;

    const result = await suggestSourcesForWorkspace(auth.workspace);
    if (!result.ok) {
      return jsonResponse(422, {
        error: 'suggest_sources_failed',
        message: result.errors[0] ?? 'Could not generate suggestions.',
        creditsCharged: result.creditsCharged,
        creditsRemaining: result.creditsRemaining,
      });
    }
    return jsonResponse(200, result);
  }

  let body: CreateSourceBody;
  try {
    body = (await request.json()) as CreateSourceBody;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  if (!body.platform) return jsonResponse(400, { error: 'platform is required' });
  if (!body.sourceType || !SOURCE_TYPES.has(body.sourceType)) {
    return jsonResponse(400, { error: 'sourceType must be one of creator, keyword, hashtag' });
  }
  if (!body.query) return jsonResponse(400, { error: 'query is required' });
  const videoLimit = body.videoLimit ?? 20;
  if (!Number.isInteger(videoLimit) || videoLimit < 1 || videoLimit > 200) {
    return jsonResponse(400, { error: 'videoLimit must be an integer between 1 and 200' });
  }
  const refreshSchedule = body.refreshSchedule ?? 'manual';
  if (!REFRESH_SCHEDULES.has(refreshSchedule)) {
    return jsonResponse(400, { error: 'refreshSchedule must be one of manual, daily, weekly' });
  }

  const result = await createSourceForWorkspace(auth.workspace, {
    platform: body.platform,
    sourceType: body.sourceType as 'creator' | 'keyword' | 'hashtag',
    query: body.query,
    language: body.language ?? 'en',
    videoLimit,
    refreshSchedule: refreshSchedule as 'manual' | 'daily' | 'weekly',
    nicheTag: body.nicheTag,
  });

  if (!result.ok) {
    return jsonResponse(422, { error: result.error, platform: result.platform, message: result.message, suggestion: result.suggestion });
  }
  return jsonResponse(200, result.source);
}

export async function PATCH(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('id');
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

  let body: UpdateSourceBody;
  try {
    body = (await request.json()) as UpdateSourceBody;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  if (body.refreshSchedule !== undefined && !REFRESH_SCHEDULES.has(body.refreshSchedule)) {
    return jsonResponse(400, { error: 'refreshSchedule must be one of manual, daily, weekly' });
  }
  if (body.videoLimit !== undefined && (!Number.isInteger(body.videoLimit) || body.videoLimit < 1 || body.videoLimit > 200)) {
    return jsonResponse(400, { error: 'videoLimit must be an integer between 1 and 200' });
  }

  const source = await updateSourceForWorkspace(auth.workspace, sourceId, {
    query: body.query,
    videoLimit: body.videoLimit,
    refreshSchedule: body.refreshSchedule as 'manual' | 'daily' | 'weekly' | undefined,
    isActive: body.isActive,
    nicheTag: body.nicheTag,
    language: body.language,
  });
  if (!source) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, source);
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sourceId = url.searchParams.get('id');
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const deleted = await deleteSourceForWorkspace(auth.workspace, sourceId);
  if (!deleted) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, { message: 'Source deleted', sourceId });
}
