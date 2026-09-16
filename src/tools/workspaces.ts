// ---------------------------------------------------------------------------
// MCP Tool: list_workspaces — which workspaces does this user own?
//
// Conversational MCP tools have no switcher: they all resolve to the caller's
// *primary* (earliest-created) workspace via requireWorkspace() (src/context.ts).
// This tool exposes the rest of the picture — every workspace the user owns —
// so an agent can tell the user what exists, which one is the default, and how
// many sources each holds. Read-only and free (no credit charge).
// ---------------------------------------------------------------------------

import { currentUserId } from '../context.js';
import { db } from '../db.js';
import { listWorkspacesForUser } from '../lib/workspaces.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerWorkspaceTools(server: McpServer) {
  server.tool(
    'list_workspaces',
    'List all workspaces owned by the authenticated user (id, name, plan, source count). '
      + 'Every other tool accepts an optional workspaceId and defaults to the primary (oldest) workspace — use isPrimary to tell which one that is. '
      + 'Free; no credits charged.',
    {},
    async () => {
      const userId = currentUserId();

      // Local stdio (single-tenant, no JWT): no owner to scope by, so list
      // every workspace. listWorkspacesForUser is account-scoped and would
      // return nothing here.
      if (!userId) {
        const workspaces = await db.workspace.findMany({ orderBy: { createdAt: 'asc' } });
        const counts = await db.source.groupBy({
          by: ['workspaceId'],
          where: { workspaceId: { in: workspaces.map((w) => w.id) } },
          _count: { _all: true },
        });
        const countById = new Map(counts.map((c) => [c.workspaceId, c._count._all]));
        const primaryId = workspaces[0]?.id ?? null;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              workspaces: workspaces.map((w) => ({
                id: w.id,
                name: w.name,
                planKey: w.planKey,
                isPrimary: w.id === primaryId,
                sourceCount: countById.get(w.id) ?? 0,
                createdAt: w.createdAt.toISOString(),
              })),
              primaryWorkspaceId: primaryId,
            }, null, 2),
          }],
        };
      }

      // Remote: account-scoped, with planKey overridden to the account's real
      // (primary workspace's) plan — see listWorkspacesForUser.
      const workspaces = await listWorkspacesForUser(userId);
      const counts = await db.source.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: workspaces.map((w) => w.id) } },
        _count: { _all: true },
      });
      const countById = new Map(counts.map((c) => [c.workspaceId, c._count._all]));
      const primaryId = workspaces[0]?.id ?? null;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            workspaces: workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              planKey: w.planKey,
              isPrimary: w.id === primaryId,
              sourceCount: countById.get(w.id) ?? 0,
              createdAt: w.createdAt.toISOString(),
            })),
            primaryWorkspaceId: primaryId,
            note: 'Tools default to the primary workspace. Pass workspaceId to any other tool to work in a different workspace.',
          }, null, 2),
        }],
      };
    },
  );
}
