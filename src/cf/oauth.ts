// OAuthProvider shell for the Worker — Phase 1 of the backend consolidation.
//
// Wraps the whole Worker fetch surface:
//   • apiHandlers['/mcp'] → the Cloudflare-native MCP handler (src/cf/mcp.ts).
//   • authorize/token/register → provider-managed OAuth 2.1 endpoints. The
//     authorize URL itself is served by the defaultHandler (login page); the
//     provider only advertises it in metadata and implements token +
//     client-registration.
//   • everything else → defaultHandler (the existing app router: pages,
//     gallery, REST APIs, crons-authenticated internals).
//
// Supabase-JWT compatibility: direct Bearer calls with a Supabase JWT are
// NOT provider-issued tokens, so the provider hands them to
// `resolveExternalToken` below, which verifies them with the existing
// remote/auth.ts (jose, cached JWKS, 15s timeout) and maps the claims to
// ctx.props — the same source getMcpAuthContext() reads inside tools.
// Unknown/garbage tokens return null → the provider's generic 401
// invalid_token (+ WWW-Authenticate resource_metadata pointer).
//
// Infra requirement: the provider persists grants/tokens in KV, so
// wrangler.jsonc must bind OAUTH_KV (see the placeholder there — the
// integrator creates it with `wrangler kv namespace create OAUTH_KV`).

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { verifySupabaseJwt } from '../../remote/auth.js';
import { ensureStore, type Env } from './env.js';
import { mcpApiHandler } from './mcp.js';

export function createOAuthProvider(
  defaultHandler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
) {
  return new OAuthProvider<Env>({
    apiHandlers: { '/mcp': mcpApiHandler },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    defaultHandler: {
      fetch: (request, env, ctx) => defaultHandler(request, env, ctx as unknown as ExecutionContext),
    },
    // Phase-1 bridge: Supabase JWTs stay valid MCP credentials until the
    // full provider-issued browser flow (login → approve → token) is wired.
    // ensureStore first: env vars (SUPABASE_URL) arrive on `env` in Workers
    // and verifySupabaseJwt reads them via process.env.
    resolveExternalToken: async ({ token, env }) => {
      await ensureStore(env as Env);
      try {
        const claims = await verifySupabaseJwt(token);
        return {
          props: {
            sub: claims.sub,
            email: claims.email ?? null,
            client_id: claims.client_id ?? null,
          },
        };
      } catch {
        return null;
      }
    },
  });
}
