// /api/social/stats — views per account over time (the Calendar "Stats" view).
//
//   GET /api/social/stats?from=&to=&bucket=day|week|month&mode=gained|posted&accounts=<id>,<id>
//
// from/to are inclusive UTC dates (YYYY-MM-DD), at most 400 days apart.
// Auth and team visibility match api/social-posts.ts.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { visibleOwnerIds } from '../src/social/index.js';
import { getSocialStats, parseStatsQuery } from '../src/social/stats.js';

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
  const parsed = parseStatsQuery({ from: p.get('from'), to: p.get('to'), bucket: p.get('bucket'), mode: p.get('mode'), accounts: p.get('accounts') });
  if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message }, request);

  const owners = await visibleOwnerIds(claims.sub, claims.email);
  return json(200, await getSocialStats(owners, parsed.query), request);
}
