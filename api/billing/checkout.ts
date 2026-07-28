// POST /api/billing/checkout — Supabase JWT auth. Creates (or reuses) the
// workspace's Stripe Customer and a Checkout Session, returns { url } for
// the caller to redirect to. Grants nothing itself — the webhook is what
// actually applies credits once Stripe confirms payment.
import { verifySupabaseJwt } from '../../remote/auth.js';
import { db } from '../../src/db.js';
import { requireStripe, priceIdFor, packPriceId } from '../../src/lib/stripe.js';
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

  let body: { planKey?: string; interval?: string };
  try {
    body = (await request.json()) as { planKey?: string; interval?: string };
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { planKey, interval } = body;
  if (planKey !== 'creator' && planKey !== 'pro' && planKey !== 'pack') {
    return json(400, { error: 'planKey must be "creator", "pro", or "pack"' });
  }
  if (planKey !== 'pack' && interval !== 'month' && interval !== 'year') {
    return json(400, { error: 'interval must be "month" or "year"' });
  }

  let workspace = await db.workspace.findUnique({ where: { ownerId: claims.sub } });
  if (!workspace) {
    workspace = await db.workspace.create({ data: { ownerId: claims.sub, name: 'My workspace' } });
  }

  const stripe = requireStripe();

  let customerId = workspace.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: typeof claims.email === 'string' ? claims.email : undefined,
      metadata: { workspaceId: workspace.id, supabaseUserId: claims.sub },
    });
    customerId = customer.id;
    await db.workspace.update({ where: { id: workspace.id }, data: { stripeCustomerId: customerId } });
  }

  let session;
  try {
    if (planKey === 'pack') {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        client_reference_id: claims.sub,
        line_items: [{ price: packPriceId(), quantity: 1 }],
        success_url: `${SITE_URL}/billing/success`,
        cancel_url: `${SITE_URL}/billing/cancel`,
      });
    } else {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: claims.sub,
        line_items: [{ price: priceIdFor(planKey, interval as string), quantity: 1 }],
        success_url: `${SITE_URL}/billing/success`,
        cancel_url: `${SITE_URL}/billing/cancel`,
        allow_promotion_codes: true,
      });
    }
  } catch (err) {
    // Most likely a missing/misconfigured STRIPE_PRICE_* env var.
    return json(500, { error: 'checkout_session_failed', message: (err as Error).message });
  }

  if (!session.url) return json(500, { error: 'checkout_session_failed', message: 'Stripe did not return a session URL' });
  return json(200, { url: session.url });
}
