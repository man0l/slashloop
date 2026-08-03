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

/** The account's real plan — i.e. the primary workspace's planKey. Every
 *  non-primary workspace's own planKey is a stale artifact after the
 *  account-level billing migration (src/lib/credits.ts); display code should
 *  read this instead of a workspace's own field. */
export async function resolveAccountPlanKey(ownerId: string): Promise<string> {
  const primary = await primaryWorkspaceByOwnerId(ownerId);
  return primary?.planKey ?? 'free';
}

/** Every workspace a user owns, with `planKey` overridden to the account's
 *  real (primary workspace's) plan — see resolveAccountPlanKey. One extra
 *  query for the whole list, not per row: every row shares the same owner. */
export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const workspaces = await db.workspace.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
  if (workspaces.length === 0) return workspaces;
  const planKey = await resolveAccountPlanKey(userId);
  return workspaces.map(w => ({ ...w, planKey }));
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
 * Create a new workspace for a user, gated by WORKSPACE_LIMITS.
 *
 * Billing is per-account (src/lib/credits.ts resolveBillingWorkspaceId),
 * anchored on a user's PRIMARY (earliest-created) workspace — the same one
 * Stripe already exclusively bills. Only that first workspace ever gets a
 * real credit grant; every subsequent one starts at zero, since its
 * planCredits/packCredits are never read for balance purposes again (every
 * debit/refund/balance check resolves to the primary regardless of which
 * workspace triggered it). Granting a free-tier stash to every additional
 * workspace pre-migration was also how a WORKSPACE_LIMITS-bounded user could
 * still farm free credits one workspace at a time.
 */
export async function createWorkspaceForUser(userId: string, name: string): Promise<Workspace> {
  const existing = await listWorkspacesForUser(userId);
  const plan = highestPlanKey(existing);
  const limit = WORKSPACE_LIMITS[plan] ?? WORKSPACE_LIMITS.free;
  if (existing.length >= limit) throw new WorkspaceLimitError(limit, plan);

  // planCredits defaults to 300 at the column level (prisma/schema.prisma) —
  // that default exists for freeTierGrant() itself, so a secondary workspace
  // MUST set it explicitly to 0 rather than omitting it, or it would silently
  // inherit the column default and grant free credits anyway.
  const grant = existing.length === 0 ? freeTierGrant() : { planKey: 'free', planCredits: 0, packCredits: 0 };
  return db.workspace.create({
    data: { ownerId: userId, name, ...grant },
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
