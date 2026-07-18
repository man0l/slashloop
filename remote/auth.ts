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
  const { payload } = await jwtVerify(token, getJwks(issuer), {
    issuer,
    audience: 'authenticated',
  });
  return payload as {
    sub: string;
    email?: string;
    client_id?: string;
    role?: string;
    [k: string]: unknown;
  };
}
