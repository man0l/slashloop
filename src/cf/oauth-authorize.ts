// Server half of the SLA-118 OAuth redirect fix.
//
// The login/authorize page (remote/pages.ts) preserves the full MCP
// authorize request through the Supabase redirectTo handoff. Once the user
// is signed in ON the authorize URL itself, the page POSTs here with the
// original query string + the Supabase access token. This handler verifies
// the JWT, re-anchors the request onto /authorize, and hands it to the
// OAuthProvider, which re-validates client_id / redirect_uri /
// response_type / PKCE and returns the 302 target for the client's
// REGISTERED redirect_uri with ?code=&state=.
//
// Security: identity comes from the verified JWT only — never from the
// query or body — so a caller cannot authorize on someone else's behalf.
// Grant props mirror resolveExternalToken in ./oauth.ts so minted
// authorizations resolve to the same claims the MCP tools read.

import { verifySupabaseJwt } from '../../remote/auth.js';
import { ensureStore, type Env } from './env.js';

interface OAuthHelpersLike {
  parseAuthRequest(request: Request): Promise<{
    responseType: string;
    clientId: string;
    redirectUri: string;
    scope: string[];
    state: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    resource?: string | string[];
  }>;
  completeAuthorization(options: {
    request: unknown;
    userId: string;
    metadata: unknown;
    scope: string[];
    props: unknown;
  }): Promise<{ redirectTo: string }>;
}

type EnvWithProvider = Env & { OAUTH_PROVIDER?: OAuthHelpersLike };

interface AuthErrorLike {
  code?: string;
  description?: string;
  redirectUri?: string;
  state?: string;
  issuer?: string;
}

function isAuthError(err: unknown): err is AuthErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { description?: unknown }).description === 'string'
  );
}

/** Build the error redirect the provider specifies (mirrors its README). */
export function oauthErrorRedirect(err: AuthErrorLike): string | null {
  if (!err.redirectUri) return null;
  const redirect = new URL(err.redirectUri);
  redirect.searchParams.set('error', err.code ?? 'server_error');
  redirect.searchParams.set('error_description', err.description ?? '');
  if (err.state) redirect.searchParams.set('state', err.state);
  if (err.issuer) redirect.searchParams.set('iss', err.issuer);
  return redirect.toString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
}

/**
 * Injectable core of POST /api/oauth/authorize/complete. Real wiring is in
 * POST below; tests inject fakes for `verify` and `provider`.
 */
export async function completeAuthorizeRequest(options: {
  /** Raw query string of the original /authorize request (with or without '?'). */
  query: string;
  token: string | null;
  requestUrl: string;
  verify: (token: string) => Promise<{ sub: string; email?: string; client_id?: string }>;
  provider: OAuthHelpersLike;
}): Promise<Response> {
  const { query, token, requestUrl, verify, provider } = options;
  if (!token) return json({ error: 'missing_token' }, 401);
  if (!query) return json({ error: 'missing_query' }, 400);

  let claims: { sub: string; email?: string; client_id?: string };
  try {
    claims = await verify(token);
  } catch {
    return json({ error: 'invalid_token' }, 401);
  }
  if (!claims?.sub) return json({ error: 'invalid_token' }, 401);

  const normalized = query.startsWith('?') ? query : `?${query}`;
  // Re-anchor onto /authorize at this deployment's origin so the provider
  // validates against the real client registration and issuer.
  const authRequest = new Request(new URL(`/authorize${normalized}`, new URL(requestUrl).origin).toString());

  let parsed: Awaited<ReturnType<OAuthHelpersLike['parseAuthRequest']>>;
  try {
    parsed = await provider.parseAuthRequest(authRequest);
  } catch (err) {
    if (isAuthError(err)) {
      const redirect = oauthErrorRedirect(err);
      // Unknown clients / invalid redirects must be rendered locally —
      // never redirect to an untrusted value.
      if (redirect) return json({ redirectTo: redirect, error: err.code });
      return json({ error: err.code, error_description: err.description }, 400);
    }
    throw err;
  }

  const { redirectTo } = await provider.completeAuthorization({
    request: parsed,
    userId: claims.sub,
    metadata: {},
    scope: parsed.scope,
    props: {
      sub: claims.sub,
      email: claims.email ?? null,
      client_id: claims.client_id ?? null,
    },
  });
  return json({ redirectTo });
}

/** POST /api/oauth/authorize/complete — router-compatible handler. */
export async function POST(request: Request, env?: Env): Promise<Response> {
  if (env) await ensureStore(env);
  const provider = (env as EnvWithProvider | undefined)?.OAUTH_PROVIDER;
  if (!provider) return json({ error: 'oauth_unavailable' }, 503);

  let query = '';
  let bodyToken: string | null = null;
  try {
    const body = (await request.json()) as { query?: unknown; accessToken?: unknown };
    if (typeof body.query === 'string') query = body.query;
    if (typeof body.accessToken === 'string') bodyToken = body.accessToken;
  } catch {
    // No JSON body — query/token may still come from header/URL below.
  }
  if (!query) query = new URL(request.url).search;

  return completeAuthorizeRequest({
    query,
    token: bearerToken(request) ?? bodyToken,
    requestUrl: request.url,
    verify: verifySupabaseJwt,
    provider,
  });
}

export async function GET(): Promise<Response> {
  return json({ error: 'method_not_allowed' }, 405);
}
