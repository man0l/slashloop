import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db.js';
import { freeTierGrant } from './lib/credits.js';

export type RequestContext = {
  /** Supabase JWT `sub` when serving remote OAuth sessions; null for local stdio. */
  userId: string | null;
  /** Supabase JWT `email` claim (lowercased by callers) — the team-membership
   *  key. Absent for local stdio and older callers; without it workspace
   *  resolution stays owner-only (today's behavior, unchanged). */
  email?: string | null;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithUser<T>(userId: string | null, fn: () => Promise<T>, email?: string | null): Promise<T> {
  return requestContext.run({ userId, email: email ?? null }, fn);
}

export function currentUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}

export function currentUserEmail(): string | null {
  return requestContext.getStore()?.email ?? null;
}

export interface RequireWorkspaceOptions {
  /**
   * Resolve a specific workspace instead of the caller's primary one — used
   * by the REST API (a user may own several workspaces, see WORKSPACE_LIMITS
   * in src/lib/workspaces.ts). Must be owned by the current user or shared
   * with them via a team invite (matched on the context email, same rule as
   * requireWorkspaceAccess in src/lib/authz.ts); throws otherwise so a
   * workspaceId never leaks another user's data.
   */
  workspaceId?: string;
}

/**
 * Resolve the workspace for this request.
 *
 * Remote, no workspaceId (all 30-odd MCP tool call sites): the caller's
 * *primary* workspace — the earliest-created one they own, auto-created on
 * first use. A user may own more than one workspace, but conversational MCP
 * tools have no switcher, so they keep resolving to this single default.
 *
 * Remote, with workspaceId (the REST API, which does have a switcher, and MCP
 * tools with an explicit workspaceId): that exact workspace, only if the
 * current user owns it or is a team member of it (email-keyed invite, same
 * rule as requireWorkspaceAccess — members are full peers).
 *
 * Local stdio: first/default workspace (legacy single-tenant, workspaceId
 * is not meaningful here and is ignored).
 */
export async function requireWorkspace(opts: RequireWorkspaceOptions = {}) {
  const userId = currentUserId();

  if (userId) {
    if (opts.workspaceId) {
      const email = currentUserEmail()?.toLowerCase() ?? null;
      const owned = await db.workspace.findFirst({
        where: {
          id: opts.workspaceId,
          ...(email
            ? { OR: [{ ownerId: userId }, { members: { some: { email } } }] }
            : { ownerId: userId }),
        },
      });
      if (!owned) throw new Error('Workspace not found.');
      return owned;
    }

    const existing = await db.workspace.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    return db.workspace.create({
      data: {
        ownerId: userId,
        name: 'My workspace',
        ...freeTierGrant(),
      },
    });
  }

  let workspace = await db.workspace.findFirst({
    where: { ownerId: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!workspace) {
    workspace = await db.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
  }
  if (!workspace) {
    workspace = await db.workspace.create({ data: { name: 'Default', ...freeTierGrant() } });
  }
  return workspace;
}
