// Shared social visibility (src/social/visibility.ts) — Prisma db is
// stubbed: team shares resolve both directions across workspace membership,
// and degrade to owner-only without an email claim.

import { describe, expect, test, mock, beforeEach } from 'bun:test';

type WorkspaceRow = { ownerId: string | null };

let sharedWithMe: WorkspaceRow[] = [];
let teammateEmails: string[] = [];
let knownUsers: Array<{ id: string }> = [];
const calls: string[] = [];

mock.module('../db.js', () => ({
  db: {
    workspace: {
      findMany: async () => {
        calls.push('workspace.findMany');
        return sharedWithMe;
      },
    },
    workspaceMember: {
      findMany: async () => {
        calls.push('workspaceMember.findMany');
        return teammateEmails.map((email) => ({ email }));
      },
    },
    user: {
      findMany: async () => {
        calls.push('user.findMany');
        return knownUsers;
      },
    },
  },
}));

const { visibleOwnerIds } = await import('./visibility.js');

beforeEach(() => {
  sharedWithMe = [];
  teammateEmails = [];
  knownUsers = [];
  calls.length = 0;
});

describe('visibleOwnerIds', () => {
  test('no email claim degrades to owner-only with zero queries', async () => {
    expect(await visibleOwnerIds('u1', undefined)).toEqual(['u1']);
    expect(await visibleOwnerIds('u1', null)).toEqual(['u1']);
    expect(calls).toEqual([]);
  });

  test('member sees owners of shared workspaces', async () => {
    sharedWithMe = [{ ownerId: 'owner1' }, { ownerId: 'owner2' }, { ownerId: null }];
    expect(await visibleOwnerIds('u2', 'Mate@X.co')).toEqual(['u2', 'owner1', 'owner2']);
  });

  test('owner sees teammates resolved through the User mirror', async () => {
    teammateEmails = ['mate@x.co', 'ghost@x.co'];
    knownUsers = [{ id: 'u9' }];
    expect(await visibleOwnerIds('u1', 'owner@acme.io')).toEqual(['u1', 'u9']);
  });

  test('empty team means just yourself', async () => {
    expect(await visibleOwnerIds('u1', 'solo@x.co')).toEqual(['u1']);
  });
});
