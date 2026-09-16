// ---------------------------------------------------------------------------
// Shared auth/authorization plumbing for the REST API (api/workspaces/*.ts,
// api/sources/*.ts, api/gallery-data.ts). Mirrors the pattern already used in
// api/billing/status.ts (manual Bearer extraction + verifySupabaseJwt, no
// framework middleware) rather than introducing a new one — just factored
// out so six-plus route files don't each re-derive it.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { verifySupabaseJwt } from '../../remote/auth.js';
import { db } from '../db.js';
import { corsHeaders } from './cors.js';

export function jsonResponse(status: number, body: unknown, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export type AuthResult =
  | { ok: true; userId: string; email?: string }
  | { ok: false; response: Response };

/** Verify the request's `Authorization: Bearer <supabase JWT>`. */
export async function requireAuth(request: Request): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, response: jsonResponse(401, { error: 'invalid_token' }, request) };

  try {
    const claims = await verifySupabaseJwt(token);
    return { ok: true, userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch {
    return { ok: false, response: jsonResponse(401, { error: 'invalid_token' }, request) };
  }
}

export type WorkspaceAuthResult =
  | { ok: true; userId: string; email?: string; workspace: Workspace }
  | { ok: false; response: Response };

/**
 * Auth + access in one call: verifies the JWT, then confirms `workspaceId`
 * is one the caller may use — owned by them, or shared with them via a team
 * invite (WorkspaceMember rows matched on the JWT's email claim, see
 * src/lib/team.ts; no roles yet, members are full peers). Never resolves a
 * workspace the caller can't access — the id in the query string is
 * untrusted input, and a workspace that exists but isn't yours answers 404
 * (not 403) so ids don't leak existence.
 */
export async function requireWorkspaceAccess(
  request: Request,
  workspaceId: string | null,
): Promise<WorkspaceAuthResult> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth;

  if (!workspaceId) return { ok: false, response: jsonResponse(400, { error: 'workspaceId is required' }, request) };

  const email = auth.email?.toLowerCase() ?? null;
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      ...(email
        ? { OR: [{ ownerId: auth.userId }, { members: { some: { email } } }] }
        : { ownerId: auth.userId }),
    },
  });
  if (!workspace) return { ok: false, response: jsonResponse(404, { error: 'workspace_not_found' }, request) };

  return { ok: true, userId: auth.userId, email: auth.email, workspace };
}
