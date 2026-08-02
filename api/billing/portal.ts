// POST /api/billing/portal — Supabase JWT auth. Returns { url } for
// Stripe's hosted Billing Portal (cancellation, plan switch, card update)
// so none of that has to be built here.
import { verifySupabaseJwt } from '../../remote/auth.js';
import { primaryWorkspaceByOwnerId } from '../../src/lib/workspaces.js';
import { requireStripe, customerIdField } from '../../src/lib/stripe.js';
import { corsHeaders, corsPreflight } from '../../src/lib/cors.js';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

export async function POST(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json(401, { error: 'invalid_token' });

  let claims;
  try {
    claims = await verifySupabaseJwt(token);
  } catch {
    return json(401, { error: 'invalid_token' });
  }

  if (!SITE_URL) return json(500, { error: 'SITE_URL is not configured on the server' });

  const workspace = await primaryWorkspaceByOwnerId(claims.sub);
  const customerId = workspace?.[customerIdField()];
  if (!customerId) {
    return json(404, { error: 'no_stripe_customer', message: 'No billing account yet — subscribe first.' });
  }

  const stripe = requireStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${SITE_URL}/account`,
  });

  return json(200, { url: portal.url });
}
