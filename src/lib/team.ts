// ---------------------------------------------------------------------------
// Team invites — a registered user invites a teammate BY EMAIL; the teammate
// keeps their own Google login and, once their Supabase JWT's `email` claim
// matches a WorkspaceMember row, sees every shared workspace in the site's
// switcher with full access (no roles yet — see requireWorkspaceAccess in
// src/lib/authz.ts). Membership is email-keyed, so the invite is live the
// moment the row exists — no invite tokens, no accept flow, and it works for
// people who haven't signed up yet.
//
// The invite email (Resend, via src/lib/email.ts) is a courtesy notification,
// never the trust path: access comes from the row, not the mail.
// ---------------------------------------------------------------------------

import type { WorkspaceMember } from '@prisma/client';
import { db } from '../db.js';
import { sendEmail, emailConfigured } from './email.js';
import { invalidateWorkspaceList } from './cache.js';

/** Soft cap per workspace. Not a permission system — a bound on rows and on
 *  Resend sends (a metered service), so a stray loop can't bill forever. */
export const MAX_MEMBERS_PER_WORKSPACE = 25;

export class TeamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

export type WorkspaceMemberView = Pick<WorkspaceMember, 'id' | 'email' | 'createdAt'>;

export async function listMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, createdAt: true },
  });
  return members.map((m) => ({ ...m, createdAt: m.createdAt }));
}

/**
 * Add `rawEmail` as a member of `workspace`. Owner-only at the route layer.
 * Idempotent (unique on [workspaceId, email]); re-inviting an existing member
 * just re-sends the notification email.
 */
export async function inviteMember(
  workspace: { id: string; name: string },
  ownerEmail: string | undefined,
  rawEmail: string,
  invitedBy: string,
): Promise<WorkspaceMemberView> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamError('invalid_email', "That doesn't look like an email address.");
  }
  if (ownerEmail && email === ownerEmail.trim().toLowerCase()) {
    throw new TeamError('self_invite', 'You already have access — this is your workspace.');
  }

  const count = await db.workspaceMember.count({ where: { workspaceId: workspace.id } });
  if (count >= MAX_MEMBERS_PER_WORKSPACE) {
    throw new TeamError(
      'member_limit_reached',
      `A workspace can have at most ${MAX_MEMBERS_PER_WORKSPACE} teammates.`,
    );
  }

  const member = await db.workspaceMember.upsert({
    where: { workspaceId_email: { workspaceId: workspace.id, email } },
    create: { workspaceId: workspace.id, email, invitedBy },
    update: {}, // already a member — keep original invitedBy/createdAt
  });

  // The teammate's switcher list is cached 60s keyed on THEIR userId, which we
  // don't know (they may never have signed in) — the TTL self-heals it.
  invalidateWorkspaceList(invitedBy);

  // Courtesy only: never let mail failure fail the invite (sendEmail already
  // never throws; a double .catch for belt-and-braces).
  if (emailConfigured()) {
    const origin = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? 'https://slashloop.dev';
    void sendEmail({
      to: email,
      subject: `${workspace.name} on Slashloop — you've been invited`,
      text:
        `You've been invited to the ${workspace.name} workspace on Slashloop.\n\n` +
        `Sign in with this email address (${email}) using Google and the workspace ` +
        `shows up in your workspace switcher:\n${origin}/login\n`,
      html:
        `<p>You've been invited to the <strong>${escapeHtml(workspace.name)}</strong> workspace on Slashloop.</p>` +
        `<p>Sign in with this email address (${escapeHtml(email)}) using Google and the workspace ` +
        `shows up in your workspace switcher.</p>` +
        `<p><a href="${origin}/login">Sign in →</a></p>`,
    }).catch(() => {});
  }

  return { id: member.id, email: member.email, createdAt: member.createdAt };
}

/** Remove a teammate. Owner-only at the route layer. */
export async function removeMember(workspaceId: string, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const deleted = await db.workspaceMember.deleteMany({ where: { workspaceId, email } });
  if (deleted.count === 0) throw new TeamError('not_a_member', 'That person is not a member of this workspace.');
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
