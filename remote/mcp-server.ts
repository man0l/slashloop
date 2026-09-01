// Runtime-neutral MCP server assembly.
//
// Shared by the HTTP API path (api/mcp.ts — Web-standard transport on Vercel
// and Workers) and the local Node dev server (remote/handlers.ts — Node
// transport). Keep Node-only imports OUT of this module: the Workers bundle
// compiles it, and the Node StreamableHTTPServerTransport drags in
// @hono/node-server / node:http, which must never enter that graph.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../src/register-tools.js';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
export const AUTHORIZATION_SERVER = `${SUPABASE_URL}/auth/v1`;

export type Claims = {
  sub: string;
  email?: string | null;
  client_id?: string | null;
} & Record<string, unknown>;

/**
 * Authenticated remote MCP: full product tools, scoped by JWT `sub` via
 * AsyncLocalStorage → requireWorkspace().
 */
export function buildRemoteMcp(claims: Claims) {
  const mcp = new McpServer({
    name: 'slashloop',
    version: '1.0.0',
    description: 'slashloop — viral content research for indie hackers.',
  });

  mcp.tool(
    'whoami',
    'Returns the authenticated user (proves the OAuth login worked).',
    {},
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { sub: claims.sub, email: claims.email ?? null, client_id: claims.client_id ?? null },
            null,
            2,
          ),
        },
      ],
    }),
  );

  registerAllTools(mcp);

  return mcp;
}
