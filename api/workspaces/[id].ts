// PATCH /api/workspaces/:id { name } — rename a workspace owned by the caller.
import { corsPreflight } from '../../src/lib/cors.js';
import { requireAuth, jsonResponse } from '../../src/lib/authz.js';
import { renameWorkspaceForUser } from '../../src/lib/workspaces.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).pathname.split('/').pop();
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
