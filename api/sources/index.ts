// GET  /api/sources?workspaceId=... — list sources for a workspace the caller owns.
// POST /api/sources { workspaceId, platform, sourceType, query, ... } — create a source.
import { corsPreflight } from '../../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../../src/lib/authz.js';
import { listSourcesForWorkspace, createSourceForWorkspace } from '../../src/lib/sources-service.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
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

const SOURCE_TYPES = new Set(['creator', 'keyword', 'hashtag']);
const REFRESH_SCHEDULES = new Set(['manual', 'daily', 'weekly']);

export async function POST(request: Request): Promise<Response> {
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
