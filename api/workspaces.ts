// GET   /api/workspaces               — list workspaces the caller owns.
// POST  /api/workspaces { name }       — create a new workspace, gated by
//       WORKSPACE_LIMITS (see src/lib/workspaces.ts) so free-tier accounts
//       can't farm unlimited free-credit grants.
// PATCH /api/workspaces/:id { name }   — rename a workspace owned by the caller.
//
// One file, not two — see api/sources.ts for why (Hobby plan's 12-function
// cap). vercel.json rewrites /api/workspaces/:id here with an `id` query param.
import { corsPreflight } from '../src/lib/cors.js';
import { requireAuth, jsonResponse } from '../src/lib/authz.js';
import { listWorkspacesForUser, createWorkspaceForUser, renameWorkspaceForUser, WorkspaceLimitError } from '../src/lib/workspaces.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function GET(request: Request): Promise<Response> {
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

export async function POST(request: Request): Promise<Response> {
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

export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return jsonResponse(400, { error: 'workspace id is required' });

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
