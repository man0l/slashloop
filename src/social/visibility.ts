// Shared social visibility for teams: connected accounts (and the posts
// scheduled through them) are visible both ways across a workspace share —
// the owner sees the member's connected accounts and vice versa. Social rows
// stay owned by the user who connected them (owner_id never changes; only
// the connector can disconnect); this module only widens READS and the
// per-group mutations that act on already-visible rows.
//
// Membership is email-keyed (WorkspaceMember.email vs the JWT email claim),
// the same rule as requireWorkspaceAccess in src/lib/authz.ts.

import { db } from '../db.js';

/**
 * Every owner_id whose social rows the caller may see: themselves, the owners
 * of workspaces shared with them, and the teammates (resolved to Supabase
 * subs via the User mirror) of workspaces they own. Without an email claim
 * this degrades to [userId] — today's owner-only behavior, unchanged.
 */
export async function visibleOwnerIds(userId: string, email: string | null | undefined): Promise<string[]> {
  const ids = new Set<string>([userId]);
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return [...ids];

  // Self-healing User mirror: nothing else in the app writes User rows, and
  // the teammate→sub lookup below depends on them. Upserting here means every
  // social read keeps the caller's row fresh; failure must not break reads.
  try {
    await db.user.upsert({
      where: { id: userId },
      update: { email: normalized },
      create: { id: userId, email: normalized },
    });
  } catch (err) {
    console.warn(`[social] user mirror upsert failed: ${(err as Error).message}`);
  }

  // Owners of workspaces shared with me.
  const sharedWithMe = await db.workspace.findMany({
    where: { members: { some: { email: normalized } } },
    select: { ownerId: true },
  });
  for (const w of sharedWithMe) {
    if (w.ownerId) ids.add(w.ownerId);
  }

  // Teammates of workspaces I own (email → sub via the User mirror; teammates
  // who never signed in have no row yet and simply resolve later). Distinct
  // is done in JS — Prisma's distinct is unsupported on the SQLite/D1 path.
  const teammateEmails = await db.workspaceMember.findMany({
    where: { workspace: { ownerId: userId } },
    select: { email: true },
  });
  const uniqueEmails = [...new Set(teammateEmails.map((m) => m.email))];
  if (uniqueEmails.length > 0) {
    const users = await db.user.findMany({
      where: { email: { in: uniqueEmails } },
      select: { id: true },
    });
    for (const u of users) ids.add(u.id);
  }

  return [...ids];
}
