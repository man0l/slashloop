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
import { cacheKey, getOrFill, invalidateWorkspaceList } from './cache.js';
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

/** Every workspace a user can see: the ones they own plus (when `email` is
 *  given) the ones they're a team member of (src/lib/team.ts). Own rows come
 *  first; `role` marks which is which. `planKey` is overridden to the
 *  OWNING account's real plan (primary workspace's planKey) on every row —
 *  display code reads this instead of a workspace's own field. No second
 *  query for own rows: they arrive ordered oldest-first, so row 0 IS the
 *  primary. (A separate findFirst used to re-ask D1 for what was already in
 *  hand — one more REST round trip on every /api/workspaces hit.) */
export async function listWorkspacesForUser(
  userId: string,
  email?: string | null,
): Promise<Array<Workspace & { role: 'owner' | 'member' }>> {
  // Cached 60s: ownership barely changes; the switcher polls this constantly.
  return getOrFill(cacheKey(['workspaces', userId]), 60_000, async () => {
    const own = await db.workspace.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
    const shared = email
      ? await db.workspace.findMany({
          where: { members: { some: { email: email.toLowerCase() } } },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    if (own.length === 0 && shared.length === 0) return [];

    const accountPlan = own[0]?.planKey ?? 'free';
    // Shared rows report the plan of the account that owns them — one query
    // per distinct owner set, not per workspace.
    const ownerIds = [...new Set(shared.map((w) => w.ownerId).filter((v): v is string => Boolean(v)))];
    const ownerPrimaries = ownerIds.length
      ? await db.workspace.findMany({ where: { ownerId: { in: ownerIds } }, orderBy: { createdAt: 'asc' } })
      : [];
    const planByOwner = new Map<string, string>();
    for (const w of ownerPrimaries) if (w.ownerId && !planByOwner.has(w.ownerId)) planByOwner.set(w.ownerId, w.planKey);

    return [
      ...own.map((w) => ({ ...w, role: 'owner' as const, planKey: accountPlan })),
      ...shared.map((w) => ({
        ...w,
        role: 'member' as const,
        planKey: (w.ownerId && planByOwner.get(w.ownerId)) || w.planKey,
      })),
    ];
  });
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
 * Deliberately counts ONLY owned workspaces (no email passed to
 * listWorkspacesForUser): being a team member of someone else's workspace
 * must never change your own creation limits.
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
  const created = await db.workspace.create({
    data: { ownerId: userId, name, ...grant },
  });
  invalidateWorkspaceList(userId);
  return created;
}

/** Rename a workspace the user owns OR is a team member of (no roles yet —
 *  members are full peers, see requireWorkspaceAccess in src/lib/authz.ts). */
export async function renameWorkspaceForUser(
  userId: string,
  email: string | null | undefined,
  workspaceId: string,
  name: string,
): Promise<Workspace> {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      ...(email
        ? { OR: [{ ownerId: userId }, { members: { some: { email: email.toLowerCase() } } }] }
        : { ownerId: userId }),
    },
  });
  if (!workspace) throw new Error('Workspace not found.');
  const updated = await db.workspace.update({ where: { id: workspaceId }, data: { name } });
  invalidateWorkspaceList(userId);
  return updated;
}
