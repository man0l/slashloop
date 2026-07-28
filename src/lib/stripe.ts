// ---------------------------------------------------------------------------
// Stripe client + Price resolution.
//
// null when STRIPE_SECRET_KEY isn't set (local/dev without billing configured)
// so the rest of the app can import this module without crashing — routes
// that actually need Stripe call requireStripe() and get a clear error
// instead of the whole deployment failing to boot.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

export const stripe: Stripe | null = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY is not set.');
  return stripe;
}

/**
 * planKey ("creator" | "pro") + interval ("month" | "year") -> Stripe Price
 * id, via env vars (docs/stripe-implementation-plan.md §8): e.g.
 * STRIPE_PRICE_CREATOR_MONTH. One-time credit packs use STRIPE_PRICE_PACK
 * directly (no interval).
 */
export function priceIdFor(planKey: string, interval: string): string {
  const envKey = `STRIPE_PRICE_${planKey.toUpperCase()}_${interval.toUpperCase()}`;
  const id = process.env[envKey];
  if (!id) throw new Error(`${envKey} is not set — add the Stripe Price id for ${planKey}/${interval}.`);
  return id;
}

export function packPriceId(): string {
  const id = process.env.STRIPE_PRICE_PACK;
  if (!id) throw new Error('STRIPE_PRICE_PACK is not set — add the Stripe Price id for the credit top-up pack.');
  return id;
}
