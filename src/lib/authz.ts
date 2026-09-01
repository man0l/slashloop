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
  if (!token) return { ok: false, response: jsonResponse(401, { error: 'invalid_token' }) };

  try {
    const claims = await verifySupabaseJwt(token);
    return { ok: true, userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch {
    return { ok: false, response: jsonResponse(401, { error: 'invalid_token' }) };
  }
}

export type WorkspaceAuthResult =
  | { ok: true; userId: string; workspace: Workspace }
  | { ok: false; response: Response };

/**
 * Auth + ownership in one call: verifies the JWT, then confirms `workspaceId`
 * is actually owned by that user. Never resolves a workspace the caller
 * doesn't own — the id in the query string is untrusted input.
 */
export async function requireOwnedWorkspace(
  request: Request,
  workspaceId: string | null,
): Promise<WorkspaceAuthResult> {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth;

  if (!workspaceId) return { ok: false, response: jsonResponse(400, { error: 'workspaceId is required' }) };

  const workspace = await db.workspace.findFirst({ where: { id: workspaceId, ownerId: auth.userId } });
  if (!workspace) return { ok: false, response: jsonResponse(404, { error: 'workspace_not_found' }) };

  return { ok: true, userId: auth.userId, workspace };
}
