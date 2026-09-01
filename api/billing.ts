// GET  /api/billing/status    — Supabase JWT auth. Read-only balance/plan
//      view for the site's account page and its post-checkout polling.
// POST /api/billing/checkout  — creates (or reuses) the workspace's Stripe
//      Customer and a Checkout Session, returns { url } to redirect to.
//      Grants nothing itself — the webhook applies credits once Stripe
//      confirms payment.
// POST /api/billing/portal    — returns { url } for Stripe's hosted Billing
//      Portal (cancellation, plan switch, card update).
//
// One file, not three — see api/sources.ts for why (Hobby plan's 12-function
// cap). vercel.json rewrites each /api/billing/<action> path here with an
// `action` query param; the URLs slashloop-site calls are unchanged.
import { verifySupabaseJwt } from '../remote/auth.js';
import { db } from '../src/db.js';
import { primaryWorkspaceByOwnerId } from '../src/lib/workspaces.js';
import { requireStripe, priceIdFor, customerIdField } from '../src/lib/stripe.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';

// $10 minimum for a credit top-up (mirrors the stepper's floor on the site).
const MIN_PACK_AMOUNT_CENTS = 1000;

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

function json(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

async function authenticate(request: Request) {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
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

async function handleStatus(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  // Read-only: create nothing here. requireWorkspace() (the MCP tool path)
  // creates a workspace on first use; a billing-status check before that
  // happens just means "you're not provisioned yet", not an error to fix
  // by creating one.
  const workspace = await primaryWorkspaceByOwnerId(claims.sub);
  if (!workspace) return json(404, { error: 'no_workspace' }, request);

  return json(200, {
    planKey: workspace.planKey,
    planCredits: workspace.planCredits,
    packCredits: workspace.packCredits,
    periodEnd: workspace.periodEnd,
    billingStatus: workspace.billingStatus,
  }, request);
}

async function handleCheckout(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  if (!SITE_URL) return json(500, { error: 'SITE_URL is not configured on the server' }, request);

  let body: { planKey?: string; interval?: string; amountCents?: number };
  try {
    body = (await request.json()) as { planKey?: string; interval?: string; amountCents?: number };
  } catch {
    return json(400, { error: 'invalid_json' }, request);
  }

  const { planKey, interval, amountCents } = body;
  if (planKey !== 'creator' && planKey !== 'pro' && planKey !== 'pack') {
    return json(400, { error: 'planKey must be "creator", "pro", or "pack"' }, request);
  }
  if (planKey !== 'pack' && interval !== 'month' && interval !== 'year') {
    return json(400, { error: 'interval must be "month" or "year"' }, request);
  }
  if (planKey === 'pack' && (!Number.isInteger(amountCents) || (amountCents as number) < MIN_PACK_AMOUNT_CENTS)) {
    return json(400, { error: `amountCents must be an integer >= ${MIN_PACK_AMOUNT_CENTS} ($${MIN_PACK_AMOUNT_CENTS / 100} minimum)` }, request);
  }

  let workspace = await primaryWorkspaceByOwnerId(claims.sub);
  if (!workspace) {
    workspace = await db.workspace.create({ data: { ownerId: claims.sub, name: 'My workspace' } });
  }

  const stripe = requireStripe();

  // Live and test mode have separate Customer id spaces in Stripe — read/
  // write whichever column matches the active STRIPE_MODE, not the live
  // one unconditionally (a live customer id used with a test key 404s).
  const field = customerIdField();
  let customerId = workspace[field];
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: typeof claims.email === 'string' ? claims.email : undefined,
      metadata: { workspaceId: workspace.id, supabaseUserId: claims.sub },
    });
    customerId = customer.id;
    await db.workspace.update({ where: { id: workspace.id }, data: { [field]: customerId } });
  }

  let session;
  try {
    if (planKey === 'pack') {
      // Variable-amount top-up: no fixed Price object, no automatic tax — the
      // amount the customer picks is exactly what they pay (tax_behavior:
      // 'exclusive' means Stripe won't add VAT/tax on top). The webhook
      // grants credits 1:1 against the amount actually charged (1 credit =
      // $0.01, see src/lib/credits.ts), not from Price metadata.
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        client_reference_id: claims.sub,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amountCents,
              tax_behavior: 'exclusive',
              product_data: { name: 'Slashloop credit top-up' },
            },
            quantity: 1,
          },
        ],
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
    return json(500, { error: 'checkout_session_failed', message: (err as Error).message }, request);
  }

  if (!session.url) return json(500, { error: 'checkout_session_failed', message: 'Stripe did not return a session URL' }, request);
  return json(200, { url: session.url }, request);
}

async function handlePortal(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  if (!SITE_URL) return json(500, { error: 'SITE_URL is not configured on the server' }, request);

  const workspace = await primaryWorkspaceByOwnerId(claims.sub);
  const customerId = workspace?.[customerIdField()];
  if (!customerId) {
    return json(404, { error: 'no_stripe_customer', message: 'No billing account yet — subscribe first.' }, request);
  }

  const stripe = requireStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${SITE_URL}/account`,
  });

  return json(200, { url: portal.url }, request);
}

export async function GET(request: Request): Promise<Response> {
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'status') return handleStatus(request);
  return json(404, { error: 'not_found' }, request);
}

export async function POST(request: Request): Promise<Response> {
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'checkout') return handleCheckout(request);
  if (action === 'portal') return handlePortal(request);
  return json(404, { error: 'not_found' }, request);
}
