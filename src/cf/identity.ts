// Native identity resolution for /mcp — the dual-accept window.
//
// Order per token: Google ID token first (peek `iss`, then JWKS-verify), then
// the Supabase JWT via remote/auth.ts — gated by ACCEPT_SUPABASE_JWT
// (default '1'; '0' disables the Supabase branch at final cutover). The `iss`
// peek is routing only, never trust: each branch still verifies the
// signature. Provider-issued tokens never reach here on the provider path
// (the provider checks its own `userId:grantId:secret` format first and only
// calls resolveExternalToken for anything else).
//
// Every branch converges on NativeIdentity { sub, email } — the ctx.props
// shape — so callers feed runWithUser(sub) → requireWorkspace() unchanged.
//
// Callers must run ensureStore(env) first: env vars arrive on `env` in
// Workers and this module reads them via process.env (same convention as
// remote/auth.ts), and ensureNativeUser touches the DB.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { verifySupabaseJwt } from '../../remote/auth.js';
import type { GoogleIdentity } from './google.js';

// ── Account linking (sibling: phase4-migrate, src/cf/account-link.ts) ──
// At merge, DELETE the stub below and use the real contract instead:
//   import { ensureNativeUser } from './account-link.js';
// The real implementation maps a Google identity to the local sub,
// transferring existing email-matched workspaces; brand-new Google users get
// sub `google:<googlesub>`. Verified 2026-09-09: the real file exports
// EXACTLY this signature, so the swap is one line — but it also needs that
// branch's Prisma schema change (User.googleSub), which must land first
// (account-link.ts alone does not typecheck without it).
export async function ensureNativeUser(_google: GoogleIdentity): Promise<{ sub: string }> {
  void _google;
  throw new Error('account-link not merged yet');
}

export interface NativeIdentity {
  sub: string;
  email: string | null;
  client_id: string | null;
}

export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Supabase branch of the dual-accept window. '0' disables it (final cutover). */
export function supabaseJwtEnabled(): boolean {
  return (process.env.ACCEPT_SUPABASE_JWT ?? '1') !== '0';
}

// ── Google ID-token verification (Authorization-header path on /mcp) ──

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// Lazily built so a missing GOOGLE_CLIENT_ID doesn't crash module load.
let _googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyGoogleIdToken(token: string): Promise<GoogleIdentity> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not set');
  if (!_googleJwks) _googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  // Bounded like remote/auth.ts: jose fetches the JWKS over plain fetch with
  // no timeout of its own; callers map any throw to 401.
  const verified = jwtVerify(token, _googleJwks, { issuer: GOOGLE_ISSUERS, audience: clientId });
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Google JWKS verification timed out after 15000ms')), 15_000);
    timer.unref?.();
  });
  const { payload } = await Promise.race([verified, timeout]);
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Google ID token missing sub');
  // Email is required: account linking matches/transfers on it.
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('Google ID token missing email');
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
  };
}

/** Unverified `iss` peek — routing only. Signature is still verified per branch. */
function peekIss(token: string): string | null {
  try {
    const seg = token.split('.')[1];
    if (!seg) return null;
    const obj = JSON.parse(b64urlDecode(seg)) as { iss?: unknown };
    return typeof obj.iss === 'string' ? obj.iss : null;
  } catch {
    return null;
  }
}

function isGoogleIss(iss: string): boolean {
  return iss === 'accounts.google.com' || iss === 'https://accounts.google.com';
}

/**
 * Dual-accept resolution for one Bearer token. Google ID tokens (by `iss`)
 * verify against Google's JWKS and map through ensureNativeUser; everything
 * else falls through to the Supabase JWT while ACCEPT_SUPABASE_JWT !== '0'.
 * Garbage/expired/misissued tokens resolve to null (callers answer 401).
 */
export async function resolveNativeToken(token: string): Promise<NativeIdentity | null> {
  const iss = peekIss(token);
  if (iss !== null && isGoogleIss(iss)) {
    try {
      const identity = await verifyGoogleIdToken(token);
      const { sub } = await ensureNativeUser({
        sub: identity.sub,
        email: identity.email,
        emailVerified: identity.emailVerified,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
      });
      return { sub, email: identity.email, client_id: null };
    } catch (err) {
      console.error(`[identity] google token rejected: ${(err as Error).message}`);
      return null;
    }
  }
  if (!supabaseJwtEnabled()) return null;
  try {
    const claims = await verifySupabaseJwt(token);
    return { sub: claims.sub, email: claims.email ?? null, client_id: claims.client_id ?? null };
  } catch {
    return null;
  }
}
