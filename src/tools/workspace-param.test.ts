// Tests for the shared workspaceId plumbing (src/tools/workspace-param.ts):
//   1. resolveToolWorkspace delegates to requireWorkspace correctly.
//   2. Every registered MCP tool accepts an optional workspaceId (so any
//      workspace from list_workspaces — e.g. a non-primary one — is reachable).

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { z } from 'zod/v4';

const PRIMARY = { id: 'ws-primary', name: 'My workspace' };
const SECOND = { id: 'ws-second', name: 'faceless maxxing' };
const SHARED = { id: 'ws-shared', name: 'Shared' };

// ownerId per workspace; invites matched on login email (see src/lib/team.ts).
const OWNERS: Record<string, string> = {
  'ws-primary': 'u1',
  'ws-second': 'u1',
  'ws-shared': 'u9',
};
const MEMBER_EMAILS: Record<string, string[]> = { 'ws-shared': ['mate@x.co'] };

mock.module('../db.js', () => ({
  db: {
    workspace: {
      findFirst: async ({ where }: { where: { id?: string; ownerId?: string; OR?: unknown[] } }) => {
        if (where.id) {
          const ownerId = OWNERS[where.id];
          if (!ownerId) return null;
          if (where.ownerId && where.ownerId !== ownerId) return null;
          if (where.OR) {
            const or = where.OR as Array<{ ownerId?: string; members?: { some: { email: string } } }>;
            const ok = or.some(
              (cond) =>
                (cond.ownerId !== undefined && cond.ownerId === ownerId) ||
                (cond.members !== undefined && MEMBER_EMAILS[where.id!]?.includes(cond.members.some.email)),
            );
            if (!ok) return null;
          } else if (where.ownerId && where.ownerId !== ownerId) {
            return null;
          }
          return { id: where.id, name: where.id, ownerId };
        }
        return { ...PRIMARY, ownerId: 'u1' };
      },
    },
  },
}));

const { resolveToolWorkspace } = await import('./workspace-param.js');
const { runWithUser } = await import('../context.js');

describe('resolveToolWorkspace', () => {
  test('omitted workspaceId resolves the primary workspace', async () => {
    const ws = await runWithUser('u1', () => resolveToolWorkspace({}));
    expect(ws.id).toBe(PRIMARY.id);
  });

  test('explicit owned workspaceId resolves that workspace', async () => {
    const ws = await runWithUser('u1', () => resolveToolWorkspace({ workspaceId: SECOND.id }));
    expect(ws.id).toBe(SECOND.id);
  });

  test('unowned workspaceId throws', async () => {
    await expect(
      runWithUser('u1', () => resolveToolWorkspace({ workspaceId: 'ws-nope' })),
    ).rejects.toThrow('Workspace not found.');
  });

  test('team member resolves a shared workspace by login email', async () => {
    const ws = await runWithUser('u2', () => resolveToolWorkspace({ workspaceId: 'ws-shared' }), 'mate@x.co');
    expect(ws.id).toBe('ws-shared');
  });

  test('team member with another login email is denied', async () => {
    await expect(
      runWithUser('u2', () => resolveToolWorkspace({ workspaceId: 'ws-shared' }), 'stranger@x.co'),
    ).rejects.toThrow('Workspace not found.');
  });

  test('no email in context keeps the owner-only rule', async () => {
    await expect(
      runWithUser('u2', () => resolveToolWorkspace({ workspaceId: 'ws-shared' })),
    ).rejects.toThrow('Workspace not found.');
  });
});

describe('registered tools accept workspaceId', () => {
  test('every tool schema has an optional workspaceId field', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerAllTools } = await import('../register-tools.js');

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAllTools(server);

    const tools = (server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    })._registeredTools;
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(40);

    const missing: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      if (name === 'list_workspaces' || name === 'whoami') continue;
      const shape = (tool.inputSchema as z.ZodObject<{ workspaceId?: z.ZodTypeAny }>)
        ?.shape?.workspaceId;
      const isOptionalString =
        shape instanceof z.ZodOptional &&
        shape.unwrap() instanceof z.ZodString;
      if (!isOptionalString) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

beforeEach(() => {
  mock.restore();
});
