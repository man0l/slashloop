// POST /api/sources/:id/refresh { workspaceId } — trigger a refresh. Always
// queued in practice (INLINE_REFRESH_MAX_VIDEOS is 0, see
// src/lib/sources-service.ts), so this responds quickly regardless of scrape size.
import { corsPreflight } from '../../../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../../../src/lib/authz.js';
import { refreshSourceForWorkspace } from '../../../src/lib/sources-service.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

interface RefreshBody {
  workspaceId?: string;
  videoLimit?: number;
}

export async function POST(request: Request): Promise<Response> {
  let body: RefreshBody;
  try {
    body = (await request.json()) as RefreshBody;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  // .../api/sources/:id/refresh — id is the second-to-last segment.
  const segments = url.pathname.split('/').filter(Boolean);
  const sourceId = segments[segments.length - 2];
  if (!sourceId) return jsonResponse(400, { error: 'source id is required' });

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
