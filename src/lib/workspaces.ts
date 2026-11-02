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
//   - list/create/rename/delete: backs the new /api/workspaces REST routes used by
//     the site's workspace switcher.
// ---------------------------------------------------------------------------

import type { Prisma, Workspace } from '@prisma/client';
import { db } from '../db.js';
import { cacheKey, getOrFill, invalidateWorkspaceList, invalidateWorkspaceReads } from './cache.js';
import { freeTierGrant } from './credits.js';
import { deletePrefix, isStorageEnabled, mediaBucket, thumbBucket } from './storage.js';

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

    // Membership has no accept step; loading the switcher while a row matches
    // this email is the first proof the invitee signed in (team.ts header).
    if (email && shared.length > 0) {
      await db.workspaceMember.updateMany({
        where: { email: email.toLowerCase(), acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
    }

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

// --- Public gallery link (SLA-1093) ----------------------------------------
// An owner-minted, revocable bearer token that grants anonymous read-only
// access to ONE workspace's outlier gallery (/s/<token> on the site, served by
// api/gallery.ts `publicToken`). Nothing else keys off it.

const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function mintPublicToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Turn sharing on for a workspace the user OWNS (members can't). Idempotent:
 *  an already-shared workspace keeps its existing token. Null = not the owner. */
export async function enablePublicLink(userId: string, workspaceId: string): Promise<string | null> {
  const owned = await db.workspace.findFirst({ where: { id: workspaceId, ownerId: userId } });
  if (!owned) return null;
  if (owned.publicToken) return owned.publicToken;
  const token = mintPublicToken();
  await db.workspace.update({ where: { id: owned.id }, data: { publicToken: token } });
  invalidateWorkspaceList(userId);
  return token;
}

/** Turn sharing off (the old URL stops resolving). False = not the owner. */
export async function disablePublicLink(userId: string, workspaceId: string): Promise<boolean> {
  const owned = await db.workspace.findFirst({ where: { id: workspaceId, ownerId: userId } });
  if (!owned) return false;
  if (owned.publicToken) {
    await db.workspace.update({ where: { id: owned.id }, data: { publicToken: null } });
    invalidateWorkspaceList(userId);
  }
  return true;
}

/** Resolve a public token to its workspace. Malformed tokens never hit the DB. */
export async function findWorkspaceByPublicToken(token: string | null | undefined): Promise<Workspace | null> {
  if (!token || !PUBLIC_TOKEN_RE.test(token)) return null;
  return db.workspace.findFirst({ where: { publicToken: token } });
}

// --- Workspace deletion (SLA-1223) ------------------------------------------
// Owner-only, irreversible. Removes the workspace and everything keyed to it:
// sources, videos (+ scores, analyses, hooks, ideas, scripts, briefs), boards,
// experiments, face library, usage log, credit ledger, jobs, suggestion
// dismissals, teammates, and every stored object under the workspace's R2
// prefixes. Social accounts/posts are account-scoped (owner_id) and stay.

export type DeleteWorkspaceRefusal =
  | 'workspace_not_found'
  | 'primary_workspace'
  | 'active_experiments';

export class DeleteWorkspaceError extends Error {
  constructor(public readonly code: DeleteWorkspaceRefusal, message: string) {
    super(message);
    this.name = 'DeleteWorkspaceError';
  }
}

export interface DeleteWorkspaceResult {
  id: string;
  sources: number;
  videos: number;
  experiments: number;
  usageLogs: number;
  storedObjects: number;
}

/**
 * Delete a workspace the user OWNS, with all of its data.
 *
 * Refuses the owner's PRIMARY (earliest-created) workspace: billing, the
 * Stripe customer/subscription and the account's credit balance are all
 * anchored there (resolveBillingWorkspaceId in src/lib/credits.ts), so
 * removing it would silently re-anchor billing onto the next workspace with
 * none of that state. It is also every free account's only workspace.
 *
 * Refuses while an experiment is planning/generating (same rule as
 * delete_experiment) so a paid render can't land on a deleted workspace.
 *
 * Rows go child-first because D1 enforces the RESTRICT foreign keys. Not one
 * transaction (D1 batch limits); every step is a scoped deleteMany, so a
 * retry after a partial failure simply finishes the job. `client` is a test
 * seam (a real SQLite file in workspace-delete.test.ts); callers omit it.
 */
export async function deleteWorkspaceForUser(
  userId: string,
  workspaceId: string,
  client: typeof db = db,
): Promise<DeleteWorkspaceResult> {
  const owned = await client.workspace.findFirst({ where: { id: workspaceId, ownerId: userId } });
  if (!owned) throw new DeleteWorkspaceError('workspace_not_found', 'Workspace not found.');

  const primary = await primaryWorkspaceByOwnerId(userId, client);
  if (primary?.id === owned.id) {
    throw new DeleteWorkspaceError(
      'primary_workspace',
      'This is your primary workspace — it holds your plan, billing and credits, so it cannot be deleted.',
    );
  }

  const running = await client.experiment.count({ where: { workspaceId, status: { in: ['planning', 'generating'] } } });
  if (running > 0) {
    throw new DeleteWorkspaceError(
      'active_experiments',
      `Cancel the ${running} running experiment${running === 1 ? '' : 's'} in this workspace before deleting it.`,
    );
  }

  const inWorkspace = { source: { workspaceId } };
  const ofVideo = { video: inWorkspace };
  const [sources, videos] = await Promise.all([
    client.source.count({ where: { workspaceId } }),
    client.video.count({ where: inWorkspace }),
  ]);

  await client.brief.deleteMany({ where: { OR: [{ analysis: ofVideo }, { idea: ofVideo }] } });
  await client.script.deleteMany({ where: { analysis: ofVideo } });
  await client.hook.deleteMany({ where: ofVideo });
  await client.swipeEntry.deleteMany({ where: { OR: [ofVideo, { board: { workspaceId } }] } });
  await client.idea.deleteMany({ where: ofVideo });
  await client.analysis.deleteMany({ where: ofVideo });
  await client.score.deleteMany({ where: ofVideo });
  await client.mediaJob.deleteMany({ where: { workspaceId } });
  await client.refreshRun.deleteMany({ where: { source: { workspaceId } } });
  await client.video.deleteMany({ where: inWorkspace });
  await client.source.deleteMany({ where: { workspaceId } });
  await client.board.deleteMany({ where: { workspaceId } });
  const experiments = (await client.experiment.deleteMany({ where: { workspaceId } })).count;
  await client.experimentWebhookOutbox.deleteMany({ where: { workspaceId } });
  await client.faceLibrary.deleteMany({ where: { workspaceId } });
  const usageLogs = (await client.usageLog.deleteMany({ where: { workspaceId } })).count;
  await client.creditLedger.deleteMany({ where: { workspaceId } });
  await client.autoAnalyzeRun.deleteMany({ where: { workspaceId } });
  await client.suggestionDismissal.deleteMany({ where: { workspaceId } });
  await client.workspaceMember.deleteMany({ where: { workspaceId } });
  await client.workspace.delete({ where: { id: workspaceId } });

  // Objects last: a failed sweep only leaks storage, never a dangling row.
  let storedObjects = 0;
  if (isStorageEnabled()) {
    const sweeps: Array<[string, string]> = [
      [thumbBucket(), `${workspaceId}/`],
      [thumbBucket(), `experiments/retained/${workspaceId}/`],
      [mediaBucket(), `${workspaceId}/`],
    ];
    for (const [bucket, prefix] of sweeps) {
      storedObjects += await deletePrefix(bucket, prefix).catch((err) => {
        console.warn(`[workspaces] could not sweep ${bucket}/${prefix}: ${(err as Error).message}`);
        return 0;
      });
    }
  }

  invalidateWorkspaceList(userId);
  invalidateWorkspaceReads(workspaceId);
  return { id: workspaceId, sources, videos, experiments, usageLogs, storedObjects };
}
