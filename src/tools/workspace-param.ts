// ---------------------------------------------------------------------------
// Shared `workspaceId` plumbing for conversational MCP tools.
//
// Every tool resolves its workspace through requireWorkspace() (src/context.ts):
// omitted → the caller's primary (earliest-created) workspace; explicit → that
// exact workspace, but only if the caller owns it (throws otherwise). Follow
// the gallery precedent (src/tools/gallery.ts): never use the raw input for
// queries or cache keys — always the resolved `workspace.id`.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';

/** Optional per-tool workspace selector. Spread into a tool's input schema. */
export const workspaceIdField = z.string().optional().describe(
  'Workspace ID to operate in (see list_workspaces for IDs). '
  + 'Defaults to your primary workspace when omitted.',
);

export type WorkspaceIdArg = { workspaceId?: string };

/** Resolve the tool's workspace: explicit owned workspace, else primary. */
export function resolveToolWorkspace(args: WorkspaceIdArg) {
  return requireWorkspace(args.workspaceId ? { workspaceId: args.workspaceId } : undefined);
}
