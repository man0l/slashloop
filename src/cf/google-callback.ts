// Native Google OAuth callback (GET /oauth/google/callback).
//
// PLACEHOLDER until the tokens agent's flow lands in src/cf/oauth.ts
// (cf/phase4-tokens): oauth.ts currently exports only createOAuthProvider, so
// there is nothing to re-export yet. This stub keeps the router additive-only
// (no existing routes changed) and fails loudly instead of 404ing the
// google agent's callback path (cf/phase4-google).
//
// Integrator (post-merge): replace the GET stub below with a re-export of the
// tokens agent's handler, e.g.
//   export { handleGoogleCallback as GET } from './oauth.js';
// and delete the 501 body. The router dispatches by HTTP method, so the export
// MUST be named GET (HEAD is routed to GET automatically).
export async function GET(_request: Request): Promise<Response> {
  return new Response(JSON.stringify({ error: 'auth flow pending merge' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}
