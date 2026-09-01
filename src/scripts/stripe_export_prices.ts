#!/usr/bin/env bun
// Export the live Stripe price IDs as the STRIPE_PRICE_* environment names
// the app expects (api/billing + the webhook's plan_key/pack_credits lookup).
//
// Complements src/scripts/stripe_setup.ts (which CREATES the prices and was
// designed for its output to be copied into Vercel by hand). This script only
// READS: it lists active prices, classifies them by the same metadata
// (plan_key | pack_credits) stripe_setup.ts writes, and prints
// `NAME=value` lines into the GitHub step summary — price IDs are public
// identifiers, so printing them is safe. The deploy workflow then picks the
// values up as GitHub variables (see scripts/sync-worker-secrets.mjs).
//
// Usage: STRIPE_SECRET_KEY=sk_live_... bun src/scripts/stripe_export_prices.ts
// Run via .github/workflows/stripe-export-env.yml.

import { appendFileSync } from 'node:fs';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const stripe = new Stripe(key);

function summary(lines: string[]) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, lines.join('\n') + '\n');
}

async function main() {
  const prices = await stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] });
  const found = new Map<string, string>();

  for (const price of prices.data) {
    const product = price.product as Stripe.Product;
    // Only our products — keyed off the metadata stripe_setup.ts writes.
    const planKey = price.metadata?.plan_key;
    const packCredits = price.metadata?.pack_credits;
    if (planKey !== 'creator' && planKey !== 'pro' && !packCredits) continue;

    let name: string | null = null;
    if (planKey === 'creator' && price.recurring?.interval === 'month') name = 'STRIPE_PRICE_CREATOR_MONTH';
    else if (planKey === 'creator' && price.recurring?.interval === 'year') name = 'STRIPE_PRICE_CREATOR_YEAR';
    else if (planKey === 'pro' && price.recurring?.interval === 'month') name = 'STRIPE_PRICE_PRO_MONTH';
    else if (planKey === 'pro' && price.recurring?.interval === 'year') name = 'STRIPE_PRICE_PRO_YEAR';
    else if (packCredits && !price.recurring) name = 'STRIPE_PRICE_PACK';

    if (name && !found.has(name)) {
      found.set(name, price.id);
      console.log(`${name}=${price.id}  (${product.name}, $${(price.unit_amount ?? 0) / 100}/${price.recurring?.interval ?? 'one-time'})`);
    }
  }

  const mode = prices.data.some((p) => p.livemode) ? 'LIVE' : 'TEST';
  const lines = [
    '## Stripe price IDs — set as GitHub VARIABLES (`gh variable set NAME`)',
    '',
    '```',
    ...[...found.entries()].map(([name, id]) => `${name}=${id}`),
    '```',
    '',
    `Mode: ${mode} — ${found.size}/5 expected prices found.`,
    found.size < 5 ? '⚠️ Missing prices: run stripe-setup.yml once first.' : '',
  ];
  summary(lines.filter(Boolean));

  if (found.size === 0) {
    console.error('No slashloop prices found — has stripe_setup.ts been run?');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
