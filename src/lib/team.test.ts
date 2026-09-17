// Team invites (src/lib/team.ts) — db and email are stubbed, so these are
// pure roster-logic tests: validation, the per-workspace member cap,
// idempotent re-invites, and removal. No D1, no Resend.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MemberRow = { id: string; workspaceId: string; email: string; invitedBy: string; createdAt: Date };

let members: MemberRow[] = [];
let sentEmails: Array<{ to: string; subject: string }> = [];
let ownedWorkspaces: Array<{ id: string; name: string }> = [
  { id: 'ws-1', name: 'Acme' },
  { id: 'ws-2', name: 'Side' },
];

mock.module('../db.js', () => ({
  db: {
    workspace: {
      findMany: async () => ownedWorkspaces,
    },
    workspaceMember: {
      count: async ({ where }: { where: { workspaceId: string } }) =>
        members.filter((m) => m.workspaceId === where.workspaceId).length,
      upsert: async ({ where, create }: { where: { workspaceId_email: { workspaceId: string; email: string } }; create: Omit<MemberRow, 'id' | 'createdAt'> }) => {
        const existing = members.find(
          (m) => m.workspaceId === where.workspaceId_email.workspaceId && m.email === where.workspaceId_email.email,
        );
        if (existing) return existing;
        const row: MemberRow = { id: `wm-${members.length + 1}`, createdAt: new Date('2026-09-16T00:00:00Z'), ...create };
        members.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { workspaceId: string; email: string } }) => {
        const before = members.length;
        members = members.filter((m) => !(m.workspaceId === where.workspaceId && m.email === where.email));
        return { count: before - members.length };
      },
      findMany: async () => members,
    },
  },
}));

mock.module('./email.js', () => ({
  emailConfigured: () => true,
  sendEmail: async (input: { to: string; subject: string }) => {
    sentEmails.push({ to: input.to, subject: input.subject });
    return { sent: true, id: 'x' };
  },
}));

mock.module('./cache.js', () => ({
  invalidateWorkspaceList: () => {},
  cacheKey: (...parts: unknown[]) => parts.join('|'),
  getOrFill: async (_key: string, _ttl: number, fill: () => unknown) => fill(),
}));

const { inviteMember, inviteMemberToAllWorkspaces, removeMember, listMembers, MAX_MEMBERS_PER_WORKSPACE, TeamError } = await import('./team.js');

// TeamError.code, not .message — toThrow() matches message text.
const errorCode = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (err) => {
      if (!(err instanceof TeamError)) throw err;
      return err.code;
    },
  );

const workspace = { id: 'ws-1', name: 'Acme' };

beforeEach(() => {
  members = [];
  sentEmails = [];
  ownedWorkspaces = [
    { id: 'ws-1', name: 'Acme' },
    { id: 'ws-2', name: 'Side' },
  ];
});

describe('inviteMember', () => {
  test('normalizes the email and creates the row', async () => {
    const m = await inviteMember(workspace, 'owner@acme.io', '  Teamie@Example.COM ', 'user-1');
    expect(m.email).toBe('teamie@example.com');
    expect(await listMembers('ws-1')).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('teamie@example.com');
  });

  test('re-invite is idempotent and keeps the original invite date', async () => {
    const first = await inviteMember(workspace, undefined, 'a@b.co', 'user-1');
    await inviteMember(workspace, undefined, 'a@b.co', 'user-2');
    const rows = await listMembers('ws-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toEqual(first.createdAt);
  });

  test('rejects garbage emails and self-invites', async () => {
    await expect(inviteMember(workspace, undefined, 'not-an-email', 'user-1')).rejects.toThrow(TeamError);
    expect(await errorCode(inviteMember(workspace, 'OWNER@acme.io', 'owner@acme.io', 'user-1'))).toBe('self_invite');
    expect(members).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  test('enforces the per-workspace member cap', async () => {
    for (let i = 0; i < MAX_MEMBERS_PER_WORKSPACE; i++) {
      await inviteMember(workspace, undefined, `p${i}@x.co`, 'user-1');
    }
    expect(await errorCode(inviteMember(workspace, undefined, 'onemore@x.co', 'user-1'))).toBe('member_limit_reached');
  });
});

describe('removeMember', () => {
  test('removes by email and errors on a non-member', async () => {
    await inviteMember(workspace, undefined, 'a@b.co', 'user-1');
    await removeMember('ws-1', 'A@B.CO');
    expect(await listMembers('ws-1')).toHaveLength(0);
    expect(await errorCode(removeMember('ws-1', 'a@b.co'))).toBe('not_a_member');
  });
});

describe('inviteMemberToAllWorkspaces', () => {
  test('adds one row per owned workspace and sends a single email', async () => {
    const result = await inviteMemberToAllWorkspaces({
      ownerId: 'user-1',
      ownerEmail: 'owner@acme.io',
      rawEmail: 'Teamie@Example.COM',
      invitedBy: 'user-1',
    });
    expect(result.email).toBe('teamie@example.com');
    expect(result.workspaces).toEqual([
      { id: 'ws-1', name: 'Acme', status: 'added' },
      { id: 'ws-2', name: 'Side', status: 'added' },
    ]);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('teamie@example.com');
  });

  test('re-invite reports already_member without new rows or mail', async () => {
    await inviteMemberToAllWorkspaces({ ownerId: 'user-1', ownerEmail: undefined, rawEmail: 'a@b.co', invitedBy: 'user-1' });
    sentEmails = [];
    const result = await inviteMemberToAllWorkspaces({ ownerId: 'user-1', ownerEmail: undefined, rawEmail: 'a@b.co', invitedBy: 'user-1' });
    expect(result.workspaces.every((w) => w.status === 'already_member')).toBe(true);
    expect(sentEmails).toHaveLength(1); // combined mail still goes out, but no new rows
    expect(members).toHaveLength(2);
  });

  test('rejects bad emails, self-invites, and ownerless callers', async () => {
    expect(await errorCode(inviteMemberToAllWorkspaces({ ownerId: 'user-1', ownerEmail: undefined, rawEmail: 'nope', invitedBy: 'user-1' }))).toBe(
      'invalid_email',
    );
    expect(
      await errorCode(inviteMemberToAllWorkspaces({ ownerId: 'user-1', ownerEmail: 'OWNER@acme.io', rawEmail: 'owner@acme.io', invitedBy: 'user-1' })),
    ).toBe('self_invite');
    ownedWorkspaces = [];
    expect(
      await errorCode(inviteMemberToAllWorkspaces({ ownerId: 'user-1', ownerEmail: undefined, rawEmail: 'a@b.co', invitedBy: 'user-1' })),
    ).toBe('no_workspaces');
    expect(members).toHaveLength(0);
  });
});
