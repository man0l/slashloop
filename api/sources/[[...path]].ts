// GET  /api/sources?workspaceId=... — list sources for a workspace the caller owns.
// POST /api/sources { workspaceId, platform, sourceType, query, ... } — create a source.
// GET/PATCH/DELETE /api/sources/:id?workspaceId=... — a single source.
// POST /api/sources/:id/refresh { workspaceId } — trigger a refresh.
//
// All four routed through this one optional-catch-all file rather than one
// file each. The Hobby plan caps a deployment at 12 Serverless Functions;
// see api/jobs/analyze.ts for the same trade made on the job-worker routes.
import { corsPreflight } from '../../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../../src/lib/authz.js';
import {
  listSourcesForWorkspace,
  createSourceForWorkspace,
  getSourceForWorkspace,
  updateSourceForWorkspace,
  deleteSourceForWorkspace,
  refreshSourceForWorkspace,
} from '../../src/lib/sources-service.js';

const SOURCE_TYPES = new Set(['creator', 'keyword', 'hashtag']);
const REFRESH_SCHEDULES = new Set(['manual', 'daily', 'weekly']);

/** Segments after /api/sources — [] for the index, [id] or [id, 'refresh']. */
function segmentsFromUrl(url: URL): string[] {
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('sources');
  return at === -1 ? [] : parts.slice(at + 1);
}

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

async function listSources(request: Request, url: URL): Promise<Response> {
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const sources = await listSourcesForWorkspace(auth.workspace, {
    platform: url.searchParams.get('platform') ?? undefined,
    sourceType: url.searchParams.get('sourceType') ?? undefined,
    isActive: url.searchParams.has('isActive') ? url.searchParams.get('isActive') === 'true' : undefined,
    nicheTag: url.searchParams.get('nicheTag') ?? undefined,
  });
  return jsonResponse(200, sources);
}

async function createSource(request: Request): Promise<Response> {
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

async function getSource(request: Request, url: URL, sourceId: string): Promise<Response> {
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const source = await getSourceForWorkspace(auth.workspace, sourceId);
  if (!source) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, source);
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

async function updateSource(request: Request, sourceId: string): Promise<Response> {
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

async function deleteSource(request: Request, url: URL, sourceId: string): Promise<Response> {
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const deleted = await deleteSourceForWorkspace(auth.workspace, sourceId);
  if (!deleted) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, { message: 'Source deleted', sourceId });
}

async function refreshSource(request: Request, sourceId: string): Promise<Response> {
  interface RefreshBody {
    workspaceId?: string;
    videoLimit?: number;
  }
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

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = segmentsFromUrl(url);

  if (segments.length === 0) return listSources(request, url);
  if (segments.length === 1) return getSource(request, url, segments[0]);
  return jsonResponse(404, { error: 'not_found' });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = segmentsFromUrl(url);

  if (segments.length === 0) return createSource(request);
  if (segments.length === 2 && segments[1] === 'refresh') return refreshSource(request, segments[0]);
  return jsonResponse(404, { error: 'not_found' });
}

export async function PATCH(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = segmentsFromUrl(url);

  if (segments.length === 1) return updateSource(request, segments[0]);
  return jsonResponse(404, { error: 'not_found' });
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = segmentsFromUrl(url);

  if (segments.length === 1) return deleteSource(request, url, segments[0]);
  return jsonResponse(404, { error: 'not_found' });
}
