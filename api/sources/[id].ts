// GET/PATCH/DELETE /api/sources/:id?workspaceId=... — a single source,
// scoped to a workspace the caller owns.
import { corsPreflight } from '../../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../../src/lib/authz.js';
import { getSourceForWorkspace, updateSourceForWorkspace, deleteSourceForWorkspace } from '../../src/lib/sources-service.js';

function sourceIdFromUrl(url: URL): string | undefined {
  return url.pathname.split('/').pop();
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const sourceId = sourceIdFromUrl(url);
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

  const source = await getSourceForWorkspace(auth.workspace, sourceId);
  if (!source) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, source);
}

const REFRESH_SCHEDULES = new Set(['manual', 'daily', 'weekly']);

interface UpdateSourceBody {
  workspaceId?: string;
  query?: string;
  videoLimit?: number;
  refreshSchedule?: string;
  isActive?: boolean;
  nicheTag?: string | null;
  language?: string;
}

export async function PATCH(request: Request): Promise<Response> {
  let body: UpdateSourceBody;
  try {
    body = (await request.json()) as UpdateSourceBody;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  const sourceId = sourceIdFromUrl(new URL(request.url));
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

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
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  const sourceId = sourceIdFromUrl(url);
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

  const deleted = await deleteSourceForWorkspace(auth.workspace, sourceId);
  if (!deleted) return jsonResponse(404, { error: 'source_not_found' });
  return jsonResponse(200, { message: 'Source deleted', sourceId });
}
