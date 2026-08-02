// ---------------------------------------------------------------------------
// Workspace management — a user may own several workspaces (agencies running
// one per client), each billed independently (see prisma/schema.prisma's
// Workspace model and docs/pricing-research.md §4c). This module owns the
// two pieces the rest of the codebase needs:
//
//   - primaryWorkspaceByOwnerId: the "primary" (earliest-created) workspace
//     for an owner. Ported out of context.ts's requireWorkspace() so the
//     billing routes (api/billing/*, api/stripe/webhook.ts), which predate
//     multi-workspace and still only ever operate on "the" workspace for a
//     user, can resolve it the same way without each re-deriving the
//     ordering rule now that Workspace.ownerId is no longer @unique.
//   - list/create/rename: backs the new /api/workspaces REST routes used by
//     the site's workspace switcher.
// ---------------------------------------------------------------------------

import type { Prisma, Workspace } from '@prisma/client';
import { db } from '../db.js';
import { freeTierGrant } from './credits.js';

type WorkspaceClient = Pick<typeof db, 'workspace'> | Prisma.TransactionClient;

/** Earliest-created workspace owned by `ownerId`, or null if they own none. */
export function primaryWorkspaceByOwnerId(
  ownerId: string,
  client: WorkspaceClient = db,
): Promise<Workspace | null> {
  return client.workspace.findFirst({ where: { ownerId }, orderBy: { createdAt: 'asc' } });
}

export function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  return db.workspace.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
}

/**
 * How many workspaces a user may own, keyed by the highest-tier plan already
 * held across their existing workspaces. Gates workspace creation — without
 * it, anyone could farm unlimited free-tier grants (300 credits + 2 sources
 * each, see freeTierGrant()) by creating workspace after workspace.
 */
export const WORKSPACE_LIMITS: Record<string, number> = {
  free: 1,
  creator: 10,
  pro: 50,
};

/** Plan tiers ordered low to high, for picking the "best" plan across a user's workspaces. */
const PLAN_RANK = ['free', 'creator', 'pro'];

function highestPlanKey(workspaces: Pick<Workspace, 'planKey'>[]): string {
  let best = 'free';
  let bestRank = 0;
  for (const w of workspaces) {
    const rank = PLAN_RANK.indexOf(w.planKey);
    if (rank > bestRank) {
      best = w.planKey;
      bestRank = rank;
    }
  }
  return best;
}

export class WorkspaceLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly planKey: string,
  ) {
    super(
      planKey === 'free'
        ? `Free plan is limited to ${limit} workspace. Upgrade a workspace to Creator or Pro to create more.`
        : `Your ${planKey} plan is limited to ${limit} workspaces.`,
    );
    this.name = 'WorkspaceLimitError';
  }
}

/**
 * Create a new workspace for a user, gated by WORKSPACE_LIMITS. The new
 * workspace always starts on its own free-tier grant — the limit controls
 * how many workspaces a user may hold, not what plan a new one inherits.
 */
export async function createWorkspaceForUser(userId: string, name: string): Promise<Workspace> {
  const existing = await listWorkspacesForUser(userId);
  const plan = highestPlanKey(existing);
  const limit = WORKSPACE_LIMITS[plan] ?? WORKSPACE_LIMITS.free;
  if (existing.length >= limit) throw new WorkspaceLimitError(limit, plan);

  return db.workspace.create({
    data: { ownerId: userId, name, ...freeTierGrant() },
  });
}

export async function renameWorkspaceForUser(
  userId: string,
  workspaceId: string,
  name: string,
): Promise<Workspace> {
  const owned = await db.workspace.findFirst({ where: { id: workspaceId, ownerId: userId } });
  if (!owned) throw new Error('Workspace not found.');
  return db.workspace.update({ where: { id: workspaceId }, data: { name } });
}
