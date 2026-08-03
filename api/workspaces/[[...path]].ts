// GET   /api/workspaces — list workspaces the caller owns.
// POST  /api/workspaces { name } — create a new workspace, gated by
//       WORKSPACE_LIMITS (see src/lib/workspaces.ts) so free-tier accounts
//       can't farm unlimited free-credit grants.
// PATCH /api/workspaces/:id { name } — rename a workspace owned by the caller.
//
// Both routed through this one optional-catch-all file rather than one file
// each. The Hobby plan caps a deployment at 12 Serverless Functions; see
// api/jobs/analyze.ts for the same trade made on the job-worker routes.
import { corsPreflight } from '../../src/lib/cors.js';
import { requireAuth, jsonResponse } from '../../src/lib/authz.js';
import { listWorkspacesForUser, createWorkspaceForUser, renameWorkspaceForUser, WorkspaceLimitError } from '../../src/lib/workspaces.js';

/** Segments after /api/workspaces — [] for the index, [id] for a single one. */
function segmentsFromUrl(url: URL): string[] {
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('workspaces');
  return at === -1 ? [] : parts.slice(at + 1);
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

async function listWorkspaces(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const workspaces = await listWorkspacesForUser(auth.userId);
  return jsonResponse(200, workspaces.map(w => ({
    id: w.id,
    name: w.name,
    planKey: w.planKey,
    createdAt: w.createdAt.toISOString(),
  })));
}

async function createWorkspace(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const name = (body.name ?? '').trim();
  if (!name) return jsonResponse(400, { error: 'name is required' });

  try {
    const workspace = await createWorkspaceForUser(auth.userId, name);
    return jsonResponse(200, { id: workspace.id, name: workspace.name, planKey: workspace.planKey, createdAt: workspace.createdAt.toISOString() });
  } catch (err) {
    if (err instanceof WorkspaceLimitError) {
      return jsonResponse(403, { error: 'workspace_limit_reached', message: err.message, limit: err.limit, planKey: err.planKey });
    }
    throw err;
  }
}

async function renameWorkspace(request: Request, id: string): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const name = (body.name ?? '').trim();
  if (!name) return jsonResponse(400, { error: 'name is required' });

  try {
    const workspace = await renameWorkspaceForUser(auth.userId, id, name);
    return jsonResponse(200, { id: workspace.id, name: workspace.name, planKey: workspace.planKey });
  } catch {
    return jsonResponse(404, { error: 'workspace_not_found' });
  }
}

export async function GET(request: Request): Promise<Response> {
  const segments = segmentsFromUrl(new URL(request.url));
  if (segments.length === 0) return listWorkspaces(request);
  return jsonResponse(404, { error: 'not_found' });
}

export async function POST(request: Request): Promise<Response> {
  const segments = segmentsFromUrl(new URL(request.url));
  if (segments.length === 0) return createWorkspace(request);
  return jsonResponse(404, { error: 'not_found' });
}

export async function PATCH(request: Request): Promise<Response> {
  const segments = segmentsFromUrl(new URL(request.url));
  if (segments.length === 1) return renameWorkspace(request, segments[0]);
  return jsonResponse(404, { error: 'not_found' });
}
