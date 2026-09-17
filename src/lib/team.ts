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

export type MailStatus = { sent: boolean; reason?: string };

async function sendInviteMail(to: { to: string; subject: string; text: string; html: string }): Promise<MailStatus> {
  // Courtesy, but REPORTED: callers surface failures in the UI instead of
  // failing silently (a missing domain verification otherwise looks like a
  // working invite). Never throws — failure is data, not an exception.
  if (!emailConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    const result = await sendEmail(to);
    return result.sent ? { sent: true } : { sent: false, reason: result.reason ?? 'unknown' };
  } catch (err) {
    return { sent: false, reason: (err as Error).message.slice(0, 200) };
  }
}

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
 * just re-sends the notification email (unless `opts.sendEmail` is false —
 * the bulk invite below sends one combined mail instead).
 */
export async function inviteMember(
  workspace: { id: string; name: string },
  ownerEmail: string | undefined,
  rawEmail: string,
  invitedBy: string,
  opts: { sendEmail?: boolean } = {},
): Promise<WorkspaceMemberView & { mail: MailStatus }> {
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

  // Courtesy, but reported: the route surfaces mail failures so a broken
  // mail setup never looks like a working invite.
  let mail: MailStatus = { sent: false, reason: 'skipped' };
  if (opts.sendEmail !== false) {
    const origin = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? 'https://slashloop.dev';
    mail = await sendInviteMail({
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
    });
  }

  return { id: member.id, email: member.email, createdAt: member.createdAt, mail };
}

/** Remove a teammate. Owner-only at the route layer. */
export async function removeMember(workspaceId: string, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const deleted = await db.workspaceMember.deleteMany({ where: { workspaceId, email } });
  if (deleted.count === 0) throw new TeamError('not_a_member', 'That person is not a member of this workspace.');
}

export type BulkInviteResult = {
  email: string;
  workspaces: Array<{ id: string; name: string; status: 'added' | 'already_member' | 'skipped_limit' }>;
  mail: MailStatus;
};

export type TeamRoster = Array<{
  id: string;
  name: string;
  members: WorkspaceMemberView[];
}>;

/** Every workspace owned by `ownerId` with its roster — the backing query
 *  for the global Team panel (no active-workspace scoping). */
export async function listTeamRoster(ownerId: string): Promise<TeamRoster> {
  const owned = await db.workspace.findMany({
    where: { ownerId },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  const roster: TeamRoster = [];
  for (const workspace of owned) {
    roster.push({ id: workspace.id, name: workspace.name, members: await listMembers(workspace.id) });
  }
  return roster;
}

/** Remove `rawEmail` from EVERY workspace owned by `ownerId`. */
export async function removeMemberFromAllWorkspaces(input: { ownerId: string; rawEmail: string }): Promise<{ email: string; removedFrom: string[] }> {
  const email = input.rawEmail.trim().toLowerCase();
  const owned = await db.workspace.findMany({ where: { ownerId: input.ownerId }, select: { id: true } });
  const removedFrom: string[] = [];
  for (const workspace of owned) {
    const deleted = await db.workspaceMember.deleteMany({ where: { workspaceId: workspace.id, email } });
    if (deleted.count > 0) removedFrom.push(workspace.id);
  }
  if (!removedFrom.length) throw new TeamError('not_a_member', 'That person is not a member of any of your workspaces.');
  invalidateWorkspaceList(input.ownerId);
  return { email, removedFrom };
}

/**
 * Invite `rawEmail` to EVERY workspace owned by `ownerId` in one call — the
 * "basic teams" flow: the teammate signs up with that email (Google login)
 * and all of the inviter's workspaces show up in their switcher, because
 * membership is email-keyed (see module header). Idempotent per workspace;
 * a full workspace reports `skipped_limit` instead of failing the batch.
 * Sends ONE combined notification email, not one per workspace.
 */
export async function inviteMemberToAllWorkspaces(input: {
  ownerId: string;
  ownerEmail: string | undefined;
  rawEmail: string;
  invitedBy: string;
}): Promise<BulkInviteResult> {
  const email = input.rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamError('invalid_email', "That doesn't look like an email address.");
  }
  if (input.ownerEmail && email === input.ownerEmail.trim().toLowerCase()) {
    throw new TeamError('self_invite', 'You already have access — these are your workspaces.');
  }

  const owned = await db.workspace.findMany({
    where: { ownerId: input.ownerId },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!owned.length) throw new TeamError('no_workspaces', 'You have no workspaces to share yet.');

  const workspaces: BulkInviteResult['workspaces'] = [];
  for (const workspace of owned) {
    const already = await db.workspaceMember.count({ where: { workspaceId: workspace.id, email } });
    if (already > 0) {
      workspaces.push({ id: workspace.id, name: workspace.name, status: 'already_member' });
      continue;
    }
    try {
      await inviteMember(workspace, input.ownerEmail, email, input.invitedBy, { sendEmail: false });
      workspaces.push({ id: workspace.id, name: workspace.name, status: 'added' });
    } catch (err) {
      if (err instanceof TeamError && err.code === 'member_limit_reached') {
        workspaces.push({ id: workspace.id, name: workspace.name, status: 'skipped_limit' });
        continue;
      }
      throw err;
    }
  }

  invalidateWorkspaceList(input.invitedBy);

  const origin = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? 'https://slashloop.dev';
  const names = workspaces
    .filter((w) => w.status !== 'skipped_limit')
    .map((w) => w.name)
    .join(', ');
  const mail = await sendInviteMail({
    to: email,
    subject: `You've been invited to ${workspaces.length === 1 ? 'a workspace' : `${workspaces.length} workspaces`} on Slashloop`,
    text:
      `You've been invited to share ${names} on Slashloop.\n\n` +
      `Sign in with this email address (${email}) using Google and the workspaces ` +
      `show up in your workspace switcher:\n${origin}/login\n`,
    html:
      `<p>You've been invited to share <strong>${escapeHtml(names)}</strong> on Slashloop.</p>` +
      `<p>Sign in with this email address (${escapeHtml(email)}) using Google and the workspaces ` +
      `show up in your workspace switcher.</p>` +
      `<p><a href="${origin}/login">Sign in →</a></p>`,
  });

  return { email, workspaces, mail };
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
