// /api/social/stats/day — which posts gained views on one UTC day (SLA-1679).
//
//   GET /api/social/stats/day?day=YYYY-MM-DD&accounts=<id>,<id>
//
// Auth and team visibility match api/social-stats.ts.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { visibleOwnerIds } from '../src/social/index.js';
import { getSocialStatsDay, parseDayQuery } from '../src/social/stats.js';

function json(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

async function authenticate(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return await verifySupabaseJwt(token);
  } catch {
    return null;
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const p = new URL(request.url).searchParams;
  const parsed = parseDayQuery({ day: p.get('day'), accounts: p.get('accounts') });
  if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message }, request);

  const owners = await visibleOwnerIds(claims.sub, claims.email);
  return json(200, await getSocialStatsDay(owners, parsed.day, parsed.accounts), request);
}
