// GET /api/billing/status — Supabase JWT auth. Read-only balance/plan view
// for the site's account page and its post-checkout polling.
import { verifySupabaseJwt } from '../../remote/auth.js';
import { db } from '../../src/db.js';
import { corsHeaders, corsPreflight } from '../../src/lib/cors.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json(401, { error: 'invalid_token' });

  let claims;
  try {
    claims = await verifySupabaseJwt(token);
  } catch {
    return json(401, { error: 'invalid_token' });
  }

  // Read-only: create nothing here. requireWorkspace() (the MCP tool path)
  // creates a workspace on first use; a billing-status check before that
  // happens just means "you're not provisioned yet", not an error to fix
  // by creating one.
  const workspace = await db.workspace.findUnique({ where: { ownerId: claims.sub } });
  if (!workspace) return json(404, { error: 'no_workspace' });

  return json(200, {
    planKey: workspace.planKey,
    planCredits: workspace.planCredits,
    packCredits: workspace.packCredits,
    periodEnd: workspace.periodEnd,
    billingStatus: workspace.billingStatus,
  });
}
