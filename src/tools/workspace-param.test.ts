// Tests for the shared workspaceId plumbing (src/tools/workspace-param.ts):
//   1. resolveToolWorkspace delegates to requireWorkspace correctly.
//   2. Every registered MCP tool accepts an optional workspaceId (so any
//      workspace from list_workspaces — e.g. a non-primary one — is reachable).

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { z } from 'zod/v4';

const PRIMARY = { id: 'ws-primary', name: 'My workspace' };
const SECOND = { id: 'ws-second', name: 'faceless maxxing' };

mock.module('../db.js', () => ({
  db: {
    workspace: {
      findFirst: async ({ where }: { where: { id?: string; ownerId?: string } }) => {
        if (where.id) return where.id === SECOND.id ? { ...SECOND, ownerId: 'u1' } : null;
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
