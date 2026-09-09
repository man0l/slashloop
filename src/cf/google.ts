// Google OAuth as the native identity upstream for the Cloudflare Worker
// (Phase 4 auth migration). Google-ONLY login — no passwords, no email sending.
//
// Workers-safe: WebCrypto/fetch only (via jose), no Supabase imports, no
// secrets hardcoded — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET come from
// process.env (populated from Worker env by ensureStore, see src/cf/env.ts).
// GOOGLE_CLIENT_SECRET is never logged.

import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Lazily built so a missing GOOGLE_CLIENT_ID doesn't crash module load (keeps
// non-auth routes like /health alive even before env is configured).
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return _jwks;
}

function callbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/oauth/google/callback`;
}

/** Builds the Google authorize URL (response_type=code, scope `openid email profile`). */
export function googleAuthorizeUrl(state: string, origin: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not set');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchanges an authorization code for the verified Google identity.
 * Verifies the returned id_token as RS256 via Google's JWKS (cached, 15s
 * timeout like remote/auth.ts); requires aud === GOOGLE_CLIENT_ID, a Google
 * iss, and email_verified true. Throws Error('invalid_google_token') on any
 * failure. GOOGLE_CLIENT_SECRET is sent to Google only, never logged.
 */
export async function exchangeCodeForIdentity(code: string, origin: string): Promise<GoogleIdentity> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) throw new Error('invalid_google_token');
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(origin),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) throw new Error('invalid_google_token');
    const data = (await res.json()) as { id_token?: unknown };
    if (typeof data.id_token !== 'string' || !data.id_token) throw new Error('invalid_google_token');

    // Bounded: jose fetches the JWKS over plain fetch with no timeout of its
    // own. A stalled Google response would otherwise hang every login request
    // forever. Same 15s race as remote/auth.ts (verification is local once
    // the JWKS is cached).
    const verified = jwtVerify(data.id_token, getJwks(), {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('JWKS verification timed out after 15000ms')), 15_000);
      timer.unref?.();
    });
    const { payload } = await Promise.race([verified, timeout]);

    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('invalid_google_token');
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('invalid_google_token');
    if (payload.email_verified !== true) throw new Error('invalid_google_token');

    const identity: GoogleIdentity = {
      sub: payload.sub,
      email: payload.email,
      emailVerified: true,
    };
    if (typeof payload.name === 'string' && payload.name) identity.name = payload.name;
    return identity;
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_google_token') throw err;
    throw new Error('invalid_google_token');
  }
}

// ── INTEGRATION (for the tokens agent — call sites to wire, do NOT edit
// oauth.ts / router.ts / worker.ts from this file) ──────────────────────────
//
// Prerequisite: run ensureStore(env) before any call below so Worker
// vars/secrets (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are copied onto
// process.env — the same pattern src/cf/oauth.ts resolveExternalToken uses.
//
// 1. Authorize redirect — start of the login flow, e.g. a GET route for
//    /oauth/google (or inside the /authorize defaultHandler). Generate a
//    cryptographically random `state`, persist it (cookie or OAUTH_KV, 10-min
//    TTL) for CSRF, then:
//
//      import { googleAuthorizeUrl } from './google.js';
//      return Response.redirect(googleAuthorizeUrl(state, origin), 302);
//
//    where `origin` is PUBLIC_URL or the request origin (same rule as
//    src/cf/mcp.ts originOf). Human step: this exact origin + path must be
//    allowlisted in Google Cloud Console (see below).
//
// 2. Callback handler — GET /oauth/google/callback (the redirect_uri built
//    above). Validate `state` against the stored value (mismatch → 403),
//    then:
//
//      import { exchangeCodeForIdentity } from './google.js';
//      const url = new URL(request.url);
//      const identity = await exchangeCodeForIdentity(url.searchParams.get('code') ?? '', origin);
//      // catch Error('invalid_google_token') → 401 invalid_token.
//
//    On success, mint the session/grant for the provider flow (login →
//    approve → token) and set the session cookie.
//
// 3. Identity → props mapping — wherever Supabase claims become ctx.props
//    today (resolveExternalToken in src/cf/oauth.ts, POST in src/cf/mcp.ts),
//    map the Google identity instead; the Google `sub` becomes the MCP user
//    id so runWithUser(sub) keeps requireWorkspace() working:
//
//      { sub: identity.sub, email: identity.email, client_id: null }
//
// Google Cloud Console step (human): APIs & Services → Credentials → the
// OAuth 2.0 Client ID → Authorized redirect URIs → add
// `<origin>/oauth/google/callback` (e.g. https://<worker-domain>/oauth/google/callback).
