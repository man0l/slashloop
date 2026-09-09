import { describe, expect, test } from 'bun:test';
import { buildLinkStatements, ensureNativeUser, nativeSubFor } from './account-link.js';

describe('nativeSubFor', () => {
  test('prefixes the raw Google subject', () => {
    expect(nativeSubFor('123')).toBe('google:123');
  });
});

describe('buildLinkStatements', () => {
  test('links the User row and moves every workspace of the old sub', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const [linkUser, moveWorkspaces] = buildLinkStatements('supa-sub', 'google:123', now);
    expect(linkUser.sql).toContain('"User"');
    expect(linkUser.params).toEqual(['google:123', now, 'supa-sub']);
    expect(moveWorkspaces.sql).toContain('"Workspace"');
    expect(moveWorkspaces.params).toEqual(['google:123', now, 'supa-sub']);
  });
});

describe('ensureNativeUser', () => {
  test('rejects an unverified email before touching the DB', async () => {
    await expect(
      ensureNativeUser({ sub: '123', email: 'a@b.c', emailVerified: false }),
    ).rejects.toThrow(/not verified/);
  });

  test('rejects a missing email before touching the DB', async () => {
    await expect(
      ensureNativeUser({ sub: '123', email: '', emailVerified: true }),
    ).rejects.toThrow(/no email/);
  });
});
