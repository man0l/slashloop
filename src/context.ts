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

/**
 * Resolve the workspace for this request.
 * Remote: one workspace per auth user (created on first use).
 * Local stdio: first/default workspace (legacy single-tenant).
 */
export async function requireWorkspace() {
  const userId = currentUserId();

  if (userId) {
    const existing = await db.workspace.findUnique({ where: { ownerId: userId } });
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
