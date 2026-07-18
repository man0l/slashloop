import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { verifySupabaseJwt } from './auth.js';
import { loginPage, consentPage } from './pages.js';
import { registerAllTools } from '../src/register-tools.js';
import { runWithUser } from '../src/context.js';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
export const AUTHORIZATION_SERVER = `${SUPABASE_URL}/auth/v1`;

export type Claims = Awaited<ReturnType<typeof verifySupabaseJwt>>;

/** Resolve this deployment's public origin: explicit PUBLIC_URL, else the request host. */
export function originFrom(req: IncomingMessage): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['host'] as string) || 'localhost';
  return `${proto}://${host}`;
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

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

export function handleHealth(req: IncomingMessage, res: ServerResponse, origin: string) {
  send(res, 200, {
    ok: true,
    service: 'slashloop',
    mode: 'remote',
    public_url: origin,
    as: AUTHORIZATION_SERVER,
    tools: 'full',
  });
}

export function handleWellKnown(req: IncomingMessage, res: ServerResponse, origin: string) {
  send(res, 200, { resource: `${origin}/mcp`, authorization_servers: [AUTHORIZATION_SERVER] });
}

export function handleLogin(req: IncomingMessage, res: ServerResponse) {
  html(res, 200, loginPage());
}

export function handleConsent(req: IncomingMessage, res: ServerResponse) {
  html(res, 200, consentPage());
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, origin: string) {
  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;

  let claims: Claims | null = null;
  if (token) {
    try {
      claims = await verifySupabaseJwt(token);
    } catch {
      claims = null;
    }
  }
  if (!claims) {
    return send(res, 401, { error: 'invalid_token' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }

  // Bind JWT sub for the whole request so tools resolve the user's workspace.
  await runWithUser(claims.sub, async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildRemoteMcp(claims!);
    await mcp.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });
}
