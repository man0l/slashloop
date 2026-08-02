// ---------------------------------------------------------------------------
// Stripe client + Price resolution.
//
// Dual-mode config: set STRIPE_MODE=live|test (default live). Live reads
// STRIPE_* vars; test reads STRIPE_TEST_*. Both sets can live on Vercel so you
// flip mode without rotating secrets. null client when the active secret key
// isn't set (local/dev without billing) so imports don't crash — routes that
// need Stripe call requireStripe().
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

export type StripeMode = 'live' | 'test';

export function stripeMode(): StripeMode {
  const raw = (process.env.STRIPE_MODE ?? 'live').trim().toLowerCase();
  if (raw === 'test' || raw === 'prod' || raw === 'live') {
    // Accept "prod" as an alias for live.
    return raw === 'test' ? 'test' : 'live';
  }
  return 'live';
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Active secret key for the current STRIPE_MODE. */
export function stripeSecretKey(): string | undefined {
  return stripeMode() === 'test' ? env('STRIPE_TEST_SECRET_KEY') : env('STRIPE_SECRET_KEY');
}

/** Active webhook signing secret for the current STRIPE_MODE. */
export function stripeWebhookSecret(): string | undefined {
  return stripeMode() === 'test' ? env('STRIPE_TEST_WEBHOOK_SECRET') : env('STRIPE_WEBHOOK_SECRET');
}

/**
 * Resolve a price env var for the active mode.
 * Live:  STRIPE_PRICE_*
 * Test:  STRIPE_TEST_PRICE_*
 */
function priceEnv(suffix: string): string | undefined {
  const prefix = stripeMode() === 'test' ? 'STRIPE_TEST_PRICE_' : 'STRIPE_PRICE_';
  return env(`${prefix}${suffix}`);
}

export const stripe: Stripe | null = (() => {
  const key = stripeSecretKey();
  return key ? new Stripe(key) : null;
})();

export function requireStripe(): Stripe {
  if (!stripe) {
    const mode = stripeMode();
    const expected = mode === 'test' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
    throw new Error(`${expected} is not set (STRIPE_MODE=${mode}).`);
  }
  return stripe;
}

/**
 * planKey ("creator" | "pro") + interval ("month" | "year") -> Stripe Price
 * id via env vars. Credit top-ups are variable-amount (api/billing/checkout.ts
 * builds price_data on the fly), so they don't go through this lookup.
 */
export function priceIdFor(planKey: string, interval: string): string {
  const suffix = `${planKey.toUpperCase()}_${interval.toUpperCase()}`;
  const id = priceEnv(suffix);
  if (!id) {
    const prefix = stripeMode() === 'test' ? 'STRIPE_TEST_PRICE_' : 'STRIPE_PRICE_';
    throw new Error(`${prefix}${suffix} is not set — add the Stripe Price id for ${planKey}/${interval} (${stripeMode()} mode).`);
  }
  return id;
}
