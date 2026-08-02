import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db.js';
import { freeTierGrant } from './lib/credits.js';

export type RequestContext = {
  /** Supabase JWT `sub` when serving remote OAuth sessions; null for local stdio. */
  userId: string | null;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ userId }, fn);
}

export function currentUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}

export interface RequireWorkspaceOptions {
  /**
   * Resolve a specific workspace instead of the caller's primary one — used
   * by the REST API (a user may own several workspaces, see WORKSPACE_LIMITS
   * in src/lib/workspaces.ts). Must be owned by the current user; throws
   * otherwise so a workspaceId never leaks another user's data.
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
 * Remote, with workspaceId (the REST API, which does have a switcher):
 * that exact workspace, only if the current user owns it.
 *
 * Local stdio: first/default workspace (legacy single-tenant, workspaceId
 * is not meaningful here and is ignored).
 */
export async function requireWorkspace(opts: RequireWorkspaceOptions = {}) {
  const userId = currentUserId();

  if (userId) {
    if (opts.workspaceId) {
      const owned = await db.workspace.findFirst({
        where: { id: opts.workspaceId, ownerId: userId },
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
