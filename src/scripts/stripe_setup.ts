#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// One-off Stripe product/price setup. Creates the Creator and Pro
// subscription products (month + year prices) and the credit-pack one-time
// price, with the metadata api/stripe/webhook.ts and api/billing/checkout.ts
// depend on (docs/stripe-implementation-plan.md §2):
//   - subscription prices: plan_key ("creator"|"pro"), credits (allotment)
//   - the pack price:      pack_credits (5000)
//
// Idempotent: matches by product name, then by price amount+interval+
// metadata, so re-running (e.g. after a partial failure) reuses what's
// already there instead of creating duplicates.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... bun src/scripts/stripe_setup.ts
// Run via .github/workflows/stripe-setup.yml — not meant to live in the
// deployed app.
// ---------------------------------------------------------------------------

import { appendFileSync } from 'node:fs';
import Stripe from 'stripe';

// Duplicated from src/lib/credits.ts rather than imported: that module pulls
// in src/db.ts, which constructs `new PrismaClient()` at import time and
// throws immediately if DATABASE_URL isn't set — this script never touches
// the database and shouldn't need it just to read a constant. Keep in sync
// with PLAN_CREDITS in src/lib/credits.ts.
const PLAN_CREDITS = { creator: 3000, pro: 10000 } as const;

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}
const stripe = new Stripe(key);

async function findOrCreateProduct(name: string): Promise<Stripe.Product> {
  const existing = await stripe.products.search({ query: `name:'${name}' AND active:'true'` }).catch(() => null);
  const hit = existing?.data.find((p) => p.name === name);
  if (hit) {
    console.log(`  product "${name}" already exists (${hit.id})`);
    return hit;
  }
  const created = await stripe.products.create({ name });
  console.log(`  created product "${name}" (${created.id})`);
  return created;
}

async function findOrCreateRecurringPrice(
  product: Stripe.Product,
  unitAmount: number,
  interval: 'month' | 'year',
  metadata: Record<string, string>,
): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const hit = prices.data.find(
    (p) => p.unit_amount === unitAmount && p.recurring?.interval === interval && p.metadata.plan_key === metadata.plan_key,
  );
  if (hit) {
    console.log(`    price ${interval}ly $${unitAmount / 100} already exists (${hit.id})`);
    return hit;
  }
  const created = await stripe.prices.create({
    product: product.id,
    unit_amount: unitAmount,
    currency: 'usd',
    recurring: { interval },
    metadata,
  });
  console.log(`    created price ${interval}ly $${unitAmount / 100} (${created.id})`);
  return created;
}

async function findOrCreateOneTimePrice(
  product: Stripe.Product,
  unitAmount: number,
  metadata: Record<string, string>,
): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const hit = prices.data.find((p) => p.unit_amount === unitAmount && !p.recurring && p.metadata.pack_credits === metadata.pack_credits);
  if (hit) {
    console.log(`    one-time price $${unitAmount / 100} already exists (${hit.id})`);
    return hit;
  }
  const created = await stripe.prices.create({ product: product.id, unit_amount: unitAmount, currency: 'usd', metadata });
  console.log(`    created one-time price $${unitAmount / 100} (${created.id})`);
  return created;
}

async function main() {
  const result: Record<string, string> = {};

  console.log('Creator ($29/mo, $290/yr — 3,000 credits)');
  const creator = await findOrCreateProduct('Slashloop Creator');
  result.STRIPE_PRICE_CREATOR_MONTH = (
    await findOrCreateRecurringPrice(creator, 2900, 'month', { plan_key: 'creator', credits: String(PLAN_CREDITS.creator) })
  ).id;
  result.STRIPE_PRICE_CREATOR_YEAR = (
    await findOrCreateRecurringPrice(creator, 29000, 'year', { plan_key: 'creator', credits: String(PLAN_CREDITS.creator) })
  ).id;

  console.log('Pro ($79/mo, $790/yr — 10,000 credits)');
  const pro = await findOrCreateProduct('Slashloop Pro');
  result.STRIPE_PRICE_PRO_MONTH = (
    await findOrCreateRecurringPrice(pro, 7900, 'month', { plan_key: 'pro', credits: String(PLAN_CREDITS.pro) })
  ).id;
  result.STRIPE_PRICE_PRO_YEAR = (
    await findOrCreateRecurringPrice(pro, 79000, 'year', { plan_key: 'pro', credits: String(PLAN_CREDITS.pro) })
  ).id;

  console.log('Credit pack ($49 one-time — 5,000 credits)');
  const pack = await findOrCreateProduct('Slashloop Credit Pack');
  result.STRIPE_PRICE_PACK = (await findOrCreateOneTimePrice(pack, 4900, { pack_credits: '5000' })).id;

  const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
  console.log('\nAdd these to Vercel (Project Settings → Environment Variables):\n');
  console.log(lines.join('\n'));

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const md = [
      '## Stripe Price IDs',
      '',
      'Add these to Vercel → Project Settings → Environment Variables:',
      '',
      '```',
      ...lines,
      '```',
      '',
    ].join('\n');
    appendFileSync(summaryPath, md);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
