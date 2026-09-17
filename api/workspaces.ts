// GET   /api/workspaces               — list workspaces the caller owns or
//                                       is a team member of (role marks which).
// POST  /api/workspaces { name }       — create a new workspace, gated by
//       WORKSPACE_LIMITS (see src/lib/workspaces.ts) so free-tier accounts
//       can't farm unlimited free-credit grants.
// PATCH /api/workspaces/:id { name }   — rename a workspace owned by the caller
//                                       or shared with them (team member).
// GET    /api/workspaces/:id/members           — list teammates (owner or member).
// POST   /api/workspaces/:id/members { email } — invite a teammate (owner only).
// DELETE /api/workspaces/:id/members?email=…   — remove a teammate (owner only).
// POST   /api/workspaces?action=invite-all { email } — invite to EVERY owned
//       workspace at once (basic teams); teammate signs up with that email
//       and all workspaces appear in their switcher.
//
// One file, not two — see api/sources.ts for why (Hobby plan's 12-function
// cap). vercel.json rewrites /api/workspaces/:id here with an `id` query param.
import { corsPreflight } from '../src/lib/cors.js';
import { requireAuth, requireWorkspaceAccess, jsonResponse } from '../src/lib/authz.js';
import { listWorkspacesForUser, createWorkspaceForUser, renameWorkspaceForUser, resolveAccountPlanKey, WorkspaceLimitError } from '../src/lib/workspaces.js';
import { listMembers, inviteMember, inviteMemberToAllWorkspaces, listTeamRoster, removeMember, removeMemberFromAllWorkspaces, TeamError } from '../src/lib/team.js';
import { db } from '../src/db.js';
import { buildWeeklyRetro } from '../src/lib/posts.js';
import { buildBenchmark } from '../src/lib/benchmark.js';

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

/** Team-member management under /api/workspaces/:id/members. Invites and
 *  removals are owner-only (no roles yet, but only the account that pays may
 *  change its roster); listing is open to every member. */
async function handleMembers(method: string, request: Request, id: string | null): Promise<Response> {
  if (method === 'GET') {
    const access = await requireWorkspaceAccess(request, id);
    if (!access.ok) return access.response;
    return jsonResponse(200, { members: await listMembers(access.workspace.id) }, request);
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const owned = id ? await db.workspace.findFirst({ where: { id, ownerId: auth.userId } }) : null;
  if (!owned) return jsonResponse(404, { error: 'workspace_not_found' }, request);

  if (method === 'POST') {
    let body: { email?: string };
    try {
      body = (await request.json()) as { email?: string };
    } catch {
      return jsonResponse(400, { error: 'invalid_json' }, request);
    }
    if (!body.email?.trim()) return jsonResponse(400, { error: 'email is required' }, request);
    try {
      const member = await inviteMember(owned, auth.email, body.email, auth.userId);
      return jsonResponse(200, member, request);
    } catch (err) {
      if (err instanceof TeamError) return jsonResponse(400, { error: err.code, message: err.message }, request);
      throw err;
    }
  }

  if (method === 'DELETE') {
    const email = new URL(request.url).searchParams.get('email') ?? '';
    if (!email.trim()) return jsonResponse(400, { error: 'email is required' }, request);
    try {
      await removeMember(owned.id, email);
      return jsonResponse(200, { ok: true }, request);
    } catch (err) {
      if (err instanceof TeamError) return jsonResponse(404, { error: err.code, message: err.message }, request);
      throw err;
    }
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, request);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resource = url.searchParams.get('resource');

  // Teammates of one workspace.
  if (resource === 'members') {
    return handleMembers('GET', request, url.searchParams.get('id'));
  }

  // Global team roster: every owned workspace with its members. Backs the
  // Team panel, which is deliberately not scoped to any active workspace.
  if (url.searchParams.get('action') === 'team') {
    const auth = await requireAuth(request);
    if (!auth.ok) return auth.response;
    return jsonResponse(200, { workspaces: await listTeamRoster(auth.userId) }, request);
  }

  // Studio reads back over already-scraped data; there is no POST posts log.
  if (resource === 'retro' || resource === 'benchmark') {
    const owned = await requireWorkspaceAccess(request, url.searchParams.get('workspaceId'));
    if (!owned.ok) return owned.response;
    if (resource === 'retro') {
      const retro = await buildWeeklyRetro(owned.workspace);
      return jsonResponse(200, retro, request);
    }
    const bench = await buildBenchmark(owned.workspace);
    return jsonResponse(200, bench, request);
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const workspaces = await listWorkspacesForUser(auth.userId, auth.email);
  return jsonResponse(200, workspaces.map(w => ({
    id: w.id,
    name: w.name,
    planKey: w.planKey,
    role: w.role,
    createdAt: w.createdAt.toISOString(),
  })), request);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('resource') === 'members') {
    return handleMembers('POST', request, url.searchParams.get('id'));
  }

  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  // Basic teams: one invite covering every workspace the caller owns.
  if (url.searchParams.get('action') === 'invite-all') {
    let body: { email?: string };
    try {
      body = (await request.json()) as { email?: string };
    } catch {
      return jsonResponse(400, { error: 'invalid_json' }, request);
    }
    if (!body.email?.trim()) return jsonResponse(400, { error: 'email is required' }, request);
    try {
      const result = await inviteMemberToAllWorkspaces({
        ownerId: auth.userId,
        ownerEmail: auth.email,
        rawEmail: body.email,
        invitedBy: auth.userId,
      });
      return jsonResponse(200, result, request);
    } catch (err) {
      if (err instanceof TeamError) return jsonResponse(400, { error: err.code, message: err.message }, request);
      throw err;
    }
  }

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, request);
  }

  const name = (body.name ?? '').trim();
  if (!name) return jsonResponse(400, { error: 'name is required' }, request);

  try {
    const workspace = await createWorkspaceForUser(auth.userId, name);
    const planKey = await resolveAccountPlanKey(auth.userId);
    return jsonResponse(200, { id: workspace.id, name: workspace.name, planKey, createdAt: workspace.createdAt.toISOString() }, request);
  } catch (err) {
    if (err instanceof WorkspaceLimitError) {
      return jsonResponse(403, { error: 'workspace_limit_reached', message: err.message, limit: err.limit, planKey: err.planKey }, request);
    }
    throw err;
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return jsonResponse(400, { error: 'workspace id is required' }, request);

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, request);
  }

  const name = (body.name ?? '').trim();
  if (!name) return jsonResponse(400, { error: 'name is required' }, request);

  try {
    const workspace = await renameWorkspaceForUser(auth.userId, auth.email, id, name);
    const planKey = await resolveAccountPlanKey(auth.userId);
    return jsonResponse(200, { id: workspace.id, name: workspace.name, planKey }, request);
  } catch {
    return jsonResponse(404, { error: 'workspace_not_found' }, request);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('resource') === 'members') {
    return handleMembers('DELETE', request, url.searchParams.get('id'));
  }

  // Remove a teammate from every owned workspace at once.
  if (url.searchParams.get('action') === 'team') {
    const auth = await requireAuth(request);
    if (!auth.ok) return auth.response;
    const email = url.searchParams.get('email') ?? '';
    if (!email.trim()) return jsonResponse(400, { error: 'email is required' }, request);
    try {
      const result = await removeMemberFromAllWorkspaces({ ownerId: auth.userId, rawEmail: email });
      return jsonResponse(200, { ok: true, ...result }, request);
    } catch (err) {
      if (err instanceof TeamError) return jsonResponse(404, { error: err.code, message: err.message }, request);
      throw err;
    }
  }
  return jsonResponse(405, { error: 'method_not_allowed' }, request);
}
