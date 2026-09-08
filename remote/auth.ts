import { createRemoteJWKSet, jwtVerify } from 'jose';

// Lazily built so a missing SUPABASE_URL doesn't crash module load (keeps
// non-auth routes like /health alive even before env is configured).
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(issuer: string) {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return _jwks;
}

export async function verifySupabaseJwt(token: string) {
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  if (!supabaseUrl) throw new Error('SUPABASE_URL not set');
  const issuer = `${supabaseUrl}/auth/v1`;
  // Bounded: jose fetches the JWKS over plain fetch with no timeout of its
  // own. A stalled Supabase response would otherwise hang every authed
  // request forever (no response, no error — the infinite-spinner shape).
  // Callers map any throw to 401; the site refreshes the session and retries
  // once, by which time the JWKS is cached and verification is local.
  const verified = jwtVerify(token, getJwks(issuer), {
    issuer,
    audience: 'authenticated',
  });
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('JWKS verification timed out after 15000ms')), 15_000);
    timer.unref?.();
  });
  const { payload } = await Promise.race([verified, timeout]);
  return payload as {
    sub: string;
    email?: string;
    client_id?: string;
    role?: string;
    [k: string]: unknown;
  };
}
