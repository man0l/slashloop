// OAuthProvider shell for the Worker — provider-issued browser flow +
// native-token dual-accept on /mcp.
//
// Wraps the whole Worker fetch surface:
//   • apiHandlers['/mcp'] → the Cloudflare-native MCP handler (src/cf/mcp.ts).
//   • authorize/token/register → provider-managed OAuth 2.1 endpoints. The
//     authorize URL itself is served by the defaultHandler wrapper below:
//     GET /authorize packs the original MCP authorization request into
//     `state` and 302s into Google (googleAuthorizeUrl — sibling-owned
//     src/cf/google.ts, phase4-google). GET /oauth/google/callback exchanges
//     the code (exchangeCodeForIdentity), maps the identity via
//     ensureNativeUser (sibling contract, phase4-migrate — see
//     src/cf/identity.ts; throws 'account-link not merged yet' until merge),
//     then approves the original request (parseAuthRequest →
//     completeAuthorization with props {sub,email}) so the provider issues
//     its own access tokens from then on.
//   • everything else → defaultHandler (the existing app router: pages,
//     gallery, REST APIs, crons-authenticated internals).
//
// Identity on /mcp (dual-accept window): provider-issued tokens validate
// inside the provider; anything else lands in `resolveExternalToken`, which
// runs resolveNativeToken (src/cf/identity.ts): Google ID token first, then
// Supabase JWT via the existing remote/auth.ts (jose, cached JWKS, 15s
// timeout) — gated by ACCEPT_SUPABASE_JWT (default '1'; '0' disables the
// Supabase branch at final cutover). Unknown/garbage tokens return null →
// the provider's generic 401 invalid_token (+ WWW-Authenticate
// resource_metadata pointer). All paths converge on props {sub,email} →
// runWithUser(sub) → requireWorkspace() unchanged.
//
// Infra requirement: the provider persists grants/tokens in KV, so
// wrangler.jsonc must bind OAUTH_KV (see the placeholder there — the
// integrator creates it with `wrangler kv namespace create OAUTH_KV`).
//
// NOTE on userId vs sub: provider access tokens, auth codes and KV keys are
// `userId:grantId:secret`, parsed with a naive split(':') (must yield exactly
// 3 parts). userId must therefore be colon-free, while native subs for new
// Google users are `google:<googlesub>`. completeAuthorization gets the
// percent-encoded userId; props.sub keeps the real sub.

import { AuthorizationError, OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { exchangeCodeForIdentity, googleAuthorizeUrl } from './google.js';
import { ensureStore, type Env } from './env.js';
import { mcpApiHandler } from './mcp.js';
import { b64urlDecode, b64urlEncode, ensureNativeUser, resolveNativeToken } from './identity.js';

type DefaultHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

interface ProviderOptions {
  apiHandlers: Record<string, typeof mcpApiHandler>;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientRegistrationEndpoint: string;
  defaultHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  };
  resolveExternalToken: (input: {
    token: string;
    request: Request;
    env: Env;
  }) => Promise<{ props: { sub: string; email: string | null; client_id: string | null } } | null>;
}

/** PUBLIC_URL wins, else the request origin — same rule as api/mcp.ts. */
function originOf(request: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/** Colon-free grant userId; props.sub keeps the real (possibly colon) sub. */
export function providerUserId(sub: string): string {
  return sub.includes(':') ? encodeURIComponent(sub) : sub;
}

// ── Browser-flow state (stateless: no KV round-trip) ──

const STATE_COOKIE = 'sl_gcsrf';
const STATE_TTL_SECONDS = 600;

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function stateCookieHeader(nonce: string, origin: string, clear: boolean): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return `${STATE_COOKIE}=${nonce}; Path=/; Max-Age=${clear ? 0 : STATE_TTL_SECONDS}; SameSite=Lax; HttpOnly${secure}`;
}

function errorPage(status: number, message: string): Response {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Sign in failed - slashloop</title></head>` +
      `<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#F1F2EF">` +
      `<div style="background:#fff;border:1px solid #E2E4DF;border-radius:14px;padding:28px;max-width:440px">` +
      `<h1 style="font-size:18px;margin:0 0 6px">Sign in failed</h1>` +
      `<p style="color:#3A424B;font-size:14px">${safe}</p></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** OAuth-correct failure once client+redirect are validated: redirect, don't render. */
function oauthErrorRedirect(err: AuthorizationError): Response {
  const u = new URL(err.redirectUri as string);
  u.searchParams.set('error', err.code);
  if (err.description) u.searchParams.set('error_description', err.description);
  if (err.state) u.searchParams.set('state', err.state);
  if (err.issuer) u.searchParams.set('iss', err.issuer);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

/**
 * GET /authorize (any method): stash the original MCP authorization query in
 * `state` (bound to a nonce cookie against login-CSRF) and 302 into Google.
 */
export async function handleAuthorize(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = originOf(request);
  const nonce = crypto.randomUUID();
  const state = b64urlEncode(JSON.stringify({ q: url.searchParams.toString(), n: nonce }));
  const headers = new Headers({
    Location: googleAuthorizeUrl(state, origin),
    'Set-Cookie': stateCookieHeader(nonce, origin, false),
  });
  return new Response(null, { status: 302, headers });
}

interface CallbackState {
  q?: unknown;
  n?: unknown;
}

function parseCallbackState(raw: string | null): { q: string; n: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(b64urlDecode(raw)) as CallbackState;
    if (typeof obj.q !== 'string' || !obj.q || typeof obj.n !== 'string' || !obj.n) return null;
    return { q: obj.q, n: obj.n };
  } catch {
    return null;
  }
}

/**
 * GET /oauth/google/callback: exchange the code, map the identity, approve
 * the original MCP authorization request so the provider issues its own
 * tokens. Requested scopes are granted as-is (no separate consent screen —
 * Google login is the consent point in this flow).
 */
export async function handleGoogleCallback(
  request: Request,
  env: Env,
  options: ProviderOptions,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { Allow: 'GET', 'Content-Type': 'application/json' },
    });
  }
  await ensureStore(env);
  const url = new URL(request.url);
  const origin = originOf(request);

  if (url.searchParams.get('error')) {
    return errorPage(400, 'Google sign-in was cancelled or failed. Close this tab and reconnect from your MCP client.');
  }

  const st = parseCallbackState(url.searchParams.get('state'));
  const cookieNonce = getCookie(request, STATE_COOKIE);
  const code = url.searchParams.get('code');
  if (!st || !code || !cookieNonce || st.n !== cookieNonce) {
    return errorPage(
      400,
      'This sign-in request expired or was already used. Close this tab and start a fresh connection from your MCP client.',
    );
  }

  let sub: string;
  let email: string;
  try {
    const identity = await exchangeCodeForIdentity(code, origin);
    email = identity.email;
    // ensureNativeUser throws 'account-link not merged yet' until the
    // phase4-migrate contract lands — integration must fail loudly here.
    sub = (await ensureNativeUser(identity)).sub;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('account-link not merged yet')) {
      return errorPage(501, `account-link not merged yet: Google login succeeded but the identity cannot be mapped to a local sub until phase4-migrate lands.`);
    }
    console.error(`[oauth] google code exchange failed: ${msg}`);
    return errorPage(502, 'Google sign-in failed during the code exchange. Please retry from your MCP client.');
  }

  const api = getOAuthApi(options, env);
  let authRequest: Awaited<ReturnType<typeof api.parseAuthRequest>>;
  try {
    authRequest = await api.parseAuthRequest(new Request(`${origin}/authorize?${st.q}`));
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectUri) return oauthErrorRedirect(err);
    const msg = err instanceof Error ? err.message : String(err);
    return errorPage(400, `Invalid authorization request: ${msg}`);
  }

  try {
    const { redirectTo } = await api.completeAuthorization({
      request: authRequest,
      userId: providerUserId(sub),
      metadata: { provider: 'google', email },
      scope: authRequest.scope,
      props: { sub, email },
    });
    const headers = new Headers({
      Location: redirectTo,
      'Set-Cookie': stateCookieHeader('', origin, true),
    });
    return new Response(null, { status: 302, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth] completeAuthorization failed: ${msg}`);
    return errorPage(500, 'Could not complete the authorization. Please reconnect from your MCP client.');
  }
}

export function createOAuthProvider(defaultHandler: DefaultHandler) {
  // Shared with getOAuthApi in handleGoogleCallback so authorize validation
  // (scopes, PKCE methods, resource pinning) matches the provider exactly.
  const options: ProviderOptions = {
    apiHandlers: { '/mcp': mcpApiHandler },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    defaultHandler: {
      // Browser flow is intercepted here so src/cf/router.ts needs NO new
      // routes: /authorize and /oauth/google/callback never reach route().
      // (The router's legacy /authorize login page is now shadowed.)
      fetch: (request, env, ctx) => {
        const e = env as Env;
        const url = new URL(request.url);
        if (url.pathname === '/authorize') return handleAuthorize(request);
        if (url.pathname === '/oauth/google/callback') {
          return handleGoogleCallback(request, e, options);
        }
        return defaultHandler(request, e, ctx as unknown as ExecutionContext);
      },
    },
    // Dual-accept bridge: provider-issued tokens validate inside the
    // provider; everything else resolves here — Google ID token first, then
    // Supabase JWT while ACCEPT_SUPABASE_JWT !== '0'.
    // ensureStore first: env vars (SUPABASE_URL, GOOGLE_CLIENT_ID) arrive on
    // `env` in Workers and the verifiers read them via process.env.
    resolveExternalToken: async ({ token, env }) => {
      await ensureStore(env as Env);
      const identity = await resolveNativeToken(token);
      if (!identity) return null;
      return {
        props: {
          sub: identity.sub,
          email: identity.email ?? null,
          client_id: identity.client_id ?? null,
        },
      };
    },
  };
  return new OAuthProvider<Env>(options);
}
