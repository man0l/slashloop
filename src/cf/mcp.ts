// Cloudflare-native MCP endpoint — Phase 1 of the backend consolidation.
//
// POST /mcp runs here through `createMcpHandler` from `agents/mcp`
// (stateless, no Durable Object / McpAgent). The 55 tools are untouched:
// every request builds a FRESH McpServer via the existing
// `buildRemoteMcp()` (whoami + registerAllTools), satisfying the SDK
// >=1.26 rule against reconnecting an already-connected server instance.
//
// Auth stays dual-accept in this phase (src/cf/identity.ts). There are two entries:
//   • Provider path (production): worker.ts wraps this module's
//     `mcpApiHandler` in OAuthProvider apiHandlers. Provider-issued tokens
//     arrive with ctx.props set; Google ID tokens and Supabase JWTs arrive
//     via the provider's `resolveExternalToken` hook (oauth.ts), which also
//     lands in ctx.props. Either way the `sub` below is the local user id
//     (Supabase sub, or `google:<googlesub>` for new Google users) and
//     `runWithUser(sub)` keeps requireWorkspace() working exactly as before.
//   • Router path (direct route() dispatch, dev/tests): POST resolves the
//     Bearer token inline with the same dual-accept resolver, like api/mcp.ts
//     does for Supabase. Non-POST methods stay 405.
//
// MCP Apps behavior is unchanged: show_gallery still returns the inline
// ui:// resource plus the signed /gallery link, and the initialize-only
// getUiCapability logging below is the same one api/mcp.ts has (kept here
// because the stateless handshake still discards the negotiating instance,
// so per-request capability branching is still impossible).

import { createMcpHandler } from 'agents/mcp';
import { getUiCapability } from '@modelcontextprotocol/ext-apps/server';
import { buildRemoteMcp } from '../../remote/mcp-server.js';
import { runWithUser } from '../context.js';
import { ensureStore, type Env } from './env.js';
import { resolveNativeToken } from './identity.js';

export interface McpAuthProps {
  sub: string;
  email?: string | null;
  client_id?: string | null;
}

/** PUBLIC_URL wins, else the request origin — same rule as api/mcp.ts. */
function originOf(request: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/** Legacy 401 shape: invalid_token + resource_metadata pointer. */
function unauthorized(origin: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } }),
    { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } },
  );
}

/**
 * Fresh authenticated server per request. Delegates to the shared
 * buildRemoteMcp() so tool registration (all 55 tools + whoami) stays
 * identical across the Vercel, local-dev, and Workers paths.
 */
export function createServer(auth: McpAuthProps) {
  return buildRemoteMcp({
    sub: auth.sub,
    email: auth.email ?? null,
    client_id: auth.client_id ?? null,
  });
}

interface HandleOptions {
  /** Worker env — runs ensureStore first. Omit only when the caller already did (worker.ts fetch / route()). */
  env?: Env;
  /** Real ExecutionContext on the provider path; a stub otherwise (createMcpHandler never touches it when authContext is set). */
  ctx?: ExecutionContext;
  /** Verified caller identity: provider ctx.props or a directly-verified Supabase JWT. */
  props?: Record<string, unknown>;
}

export async function handleMcpRequest(request: Request, opts: HandleOptions = {}): Promise<Response> {
  if (opts.env) await ensureStore(opts.env, opts.ctx);

  const props = opts.props ?? {};
  const sub = typeof props.sub === 'string' && props.sub ? props.sub : null;
  if (!sub) return unauthorized(originOf(request));

  const email = typeof props.email === 'string' ? props.email : null;
  const clientId = typeof props.client_id === 'string' ? props.client_id : null;

  // Explicit authContext (not ctx.props sniffing) so getMcpAuthContext()
  // works identically on the provider path and the direct-router path.
  const authContext = { props: { sub, email, client_id: clientId } };
  const ctx =
    opts.ctx ??
    ({ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

  let response!: Response;
  await runWithUser(sub, async () => {
    // NOTE: do NOT hoist this out of the request — SDK >=1.26 throws when an
    // already-connected server instance is connected to a second transport.
    const mcp = createServer({ sub, email, client_id: clientId });
    const handler = createMcpHandler(mcp, { route: '/mcp', authContext });
    response = await handler(request, opts.env, ctx);

    // Same initialize-only capability log as api/mcp.ts: getClientCapabilities()
    // is defined only on the request that carried `initialize`, so this logs
    // roughly once per connection and tells "host won't render MCP Apps"
    // apart from "host tried and failed" (ext-apps#671).
    const ui = getUiCapability(mcp.server.getClientCapabilities());
    if (ui !== undefined) {
      console.log(`mcp-apps host=${JSON.stringify(mcp.server.getClientVersion()?.name ?? '?')} ui=true mimeTypes=${JSON.stringify(ui.mimeTypes ?? [])}`);
    } else if (mcp.server.getClientCapabilities() !== undefined) {
      console.log(`mcp-apps host=${JSON.stringify(mcp.server.getClientVersion()?.name ?? '?')} ui=false (no io.modelcontextprotocol/ui at initialize — gallery will not render inline; /gallery link is the path)`);
    }
  });
  return response;
}

/** OAuthProvider apiHandlers['/mcp'] entry — ctx.props was set by the provider. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: Record<string, unknown> }).props ?? {};
    return handleMcpRequest(request, { env, ctx, props });
  },
};

// ── Router-compatible per-method exports (src/cf/router.ts dispatches by
// method; worker.ts runs ensureStore(env) before route(), so env is omitted
// here and Supabase verification happens inline, as in api/mcp.ts). ──

export async function POST(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  let props: Record<string, unknown> = {};
  if (token) {
    // Same dual-accept resolver as the provider path (Google ID token, then
    // Supabase JWT while ACCEPT_SUPABASE_JWT !== '0'). Unresolvable → {} →
    // the 401 in handleMcpRequest. (worker.ts runs ensureStore(env) before
    // route(), which the resolver's env-var/DB access relies on.)
    const identity = await resolveNativeToken(token);
    if (identity) {
      props = { sub: identity.sub, email: identity.email ?? null, client_id: identity.client_id ?? null };
    }
  }
  return handleMcpRequest(request, { props });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}
export async function PUT(): Promise<Response> {
  return methodNotAllowed();
}
export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
