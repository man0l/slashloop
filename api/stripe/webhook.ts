// POST /api/stripe/webhook — the only thing that grants or revokes billing
// entitlement. Never grant credits from a client-controlled redirect (e.g.
// /billing/success) — the user can close the tab before it fires, and a
// success_url is trivially replayable. This is the source of truth.
//
// Idempotency: the StripeEvent insert and the event's Workspace/CreditLedger
// mutation happen in one db.$transaction. A duplicate event id fails the
// insert and rolls back the whole transaction (nothing double-applied); a
// mutation failure rolls back the insert too, so a Stripe retry after a
// transient error reprocesses instead of being silently swallowed by an
// event id that "looks" already-handled.
import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { db } from '../../src/db.js';
import { requireStripe } from '../../src/lib/stripe.js';
import { PLAN_CREDITS, FREE_TIER_PLAN_CREDITS, txSetPlan, txAddPackCredits, txUpdateBillingFields } from '../../src/lib/credits.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stripe's subscription.status values collapsed onto our three-value
 *  billingStatus. customer.subscription.deleted (not this) is what actually
 *  downgrades to free; this just tracks payment health while active. */
function mapSubStatus(status: Stripe.Subscription.Status): 'active' | 'past_due' | 'canceled' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    default:
      return 'active';
  }
}

/** current_period_start/end live on the Subscription in most API versions
 *  but moved to the first item in some; check both so a version mismatch
 *  between what this was written against and what's actually configured
 *  degrades to "leave periodStart/End unset" rather than throwing. */
function subscriptionPeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const startSec = (sub as unknown as { current_period_start?: number }).current_period_start ?? item?.current_period_start;
  const endSec = (sub as unknown as { current_period_end?: number }).current_period_end ?? item?.current_period_end;
  return {
    start: typeof startSec === 'number' ? new Date(startSec * 1000) : null,
    end: typeof endSec === 'number' ? new Date(endSec * 1000) : null,
  };
}

async function handleCheckoutCompleted(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  if (!session.client_reference_id) {
    console.warn(`[stripe-webhook] checkout.session.completed ${session.id} has no client_reference_id, skipping`);
    return;
  }
  const workspace = await tx.workspace.findUnique({ where: { ownerId: session.client_reference_id } });
  if (!workspace) {
    console.warn(`[stripe-webhook] no workspace for owner ${session.client_reference_id} (session ${session.id})`);
    return;
  }

  // The webhook payload doesn't include line items by default — fetch them.
  const full = await requireStripe().checkout.sessions.retrieve(session.id, {
    expand: ['line_items.data.price'],
  });
  const price = full.line_items?.data?.[0]?.price as Stripe.Price | undefined;
  if (!price) {
    console.warn(`[stripe-webhook] checkout session ${session.id} has no line item price, skipping`);
    return;
  }

  if (session.mode === 'subscription') {
    const planKey = price.metadata.plan_key;
    const credits = planKey && PLAN_CREDITS[planKey] !== undefined ? PLAN_CREDITS[planKey] : Number(price.metadata.credits ?? 0);
    if (!planKey || !(planKey in PLAN_CREDITS)) {
      console.warn(`[stripe-webhook] price ${price.id} has no recognized plan_key metadata, skipping plan grant`);
      return;
    }
    await txSetPlan(
      tx,
      workspace.id,
      {
        planKey,
        planCredits: credits,
        billingStatus: 'active',
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
      },
      event.id,
      'subscription_create',
    );
  } else if (session.mode === 'payment') {
    const packCredits = Number(price.metadata.pack_credits ?? 0);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (customerId) await txUpdateBillingFields(tx, workspace.id, { stripeCustomerId: customerId });
    if (packCredits > 0) {
      await txAddPackCredits(tx, workspace.id, packCredits, event.id, 'pack_purchase');
    } else {
      console.warn(`[stripe-webhook] payment-mode session ${session.id} price ${price.id} has no pack_credits metadata`);
    }
  }
}

async function handleSubscriptionUpdated(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const workspace = await tx.workspace.findUnique({ where: { stripeCustomerId: customerId } });
  if (!workspace) {
    // Can race checkout.session.completed if Stripe delivers this first —
    // that handler will set stripeCustomerId shortly; nothing to sync yet.
    return;
  }
  const { start, end } = subscriptionPeriod(sub);
  await txUpdateBillingFields(tx, workspace.id, {
    periodStart: start,
    periodEnd: end,
    billingStatus: mapSubStatus(sub.status),
    stripeSubscriptionId: sub.id,
  });
  // Mid-cycle plan changes (upgrade/downgrade) are deliberately not re-granted
  // here — see docs/stripe-implementation-plan.md Phase 4. This only syncs
  // status/period; the next invoice.paid renewal picks up the new plan's
  // allotment via the workspace's current planKey.
}

async function handleInvoicePaid(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.billing_reason !== 'subscription_cycle') return; // initial invoice: handled by checkout.session.completed
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;
  const workspace = await tx.workspace.findUnique({ where: { stripeCustomerId: customerId } });
  if (!workspace) return;
  const credits = PLAN_CREDITS[workspace.planKey];
  if (credits === undefined) {
    console.warn(`[stripe-webhook] workspace ${workspace.id} has unrecognized planKey "${workspace.planKey}" at renewal, skipping reset`);
    return;
  }
  await txSetPlan(tx, workspace.id, { planKey: workspace.planKey, planCredits: credits, billingStatus: 'active' }, event.id, 'subscription_renewal');
}

async function handleInvoicePaymentFailed(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;
  const workspace = await tx.workspace.findUnique({ where: { stripeCustomerId: customerId } });
  if (!workspace) return;
  await txUpdateBillingFields(tx, workspace.id, { billingStatus: 'past_due' });
}

async function handleSubscriptionDeleted(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const workspace = await tx.workspace.findUnique({ where: { stripeCustomerId: customerId } });
  if (!workspace) return;
  // Downgrade, not delete: packCredits (paid for separately) are untouched
  // because txSetPlan only ever sets planKey/planCredits.
  await txSetPlan(
    tx,
    workspace.id,
    { planKey: 'free', planCredits: FREE_TIER_PLAN_CREDITS, billingStatus: 'canceled', stripeSubscriptionId: null },
    event.id,
    'subscription_canceled',
  );
}

async function handleEvent(tx: Prisma.TransactionClient, event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(tx, event);
    case 'customer.subscription.updated':
    case 'customer.subscription.created':
      return handleSubscriptionUpdated(tx, event);
    case 'invoice.paid':
      return handleInvoicePaid(tx, event);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(tx, event);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(tx, event);
    default:
      // Unhandled event type — ack (200) so Stripe stops retrying, no-op.
      return;
  }
}

export async function POST(request: Request): Promise<Response> {
  const stripe = requireStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(500, { error: 'STRIPE_WEBHOOK_SECRET is not set' });

  const raw = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) return json(400, { error: 'missing_signature' });

  let event: Stripe.Event;
  try {
    // Async variant: uses Web Crypto rather than Node's synchronous crypto,
    // which is the portable choice for a Web Standard Request/Response
    // handler whose actual runtime (Node vs Edge) isn't guaranteed here.
    event = await stripe.webhooks.constructEventAsync(raw, sig, secret);
  } catch (err) {
    return json(400, { error: `signature_verification_failed: ${(err as Error).message}` });
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type, payloadJson: raw } });
      await handleEvent(tx, event);
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Already processed — success, not an error. Stripe should not retry.
      return json(200, { received: true, duplicate: true });
    }
    console.error(`[stripe-webhook] handler failed for ${event.id} (${event.type}):`, err);
    // 500 makes Stripe retry with the same event id. Because the StripeEvent
    // insert rolled back with the failed mutation, the retry will not hit
    // the duplicate branch above — it reprocesses from scratch.
    return json(500, { error: 'handler_failed' });
  }

  return json(200, { received: true });
}

export async function GET(): Promise<Response> {
  return json(405, { error: 'method_not_allowed' });
}
