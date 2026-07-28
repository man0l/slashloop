#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// One-off Stripe webhook endpoint setup.
//
// Registers (or reconciles) the webhook endpoint that api/stripe/webhook.ts
// serves, subscribed to exactly the events its handleEvent() switch handles.
//
// Idempotent: matches an existing endpoint by URL. If found, it updates the
// enabled_events to the canonical list rather than creating a duplicate —
// Stripe happily allows several endpoints on the same URL, which would mean
// every event delivered N times.
//
// SIGNING SECRET: deliberately NOT printed. Stripe returns it only when the
// endpoint is first created, and GitHub Actions cannot mask a value it didn't
// already know about — so echoing it would write a live secret into the run
// logs and job summary, both of which persist. This script prints a direct
// dashboard link to reveal it instead.
//
// Usage: STRIPE_SECRET_KEY=sk_... ENDPOINT_URL=https://host/api/stripe/webhook \
//          bun src/scripts/stripe_webhook_setup.ts
// Run via .github/workflows/stripe-webhook-setup.yml.
// ---------------------------------------------------------------------------

import { appendFileSync } from 'node:fs';
import Stripe from 'stripe';

// Must stay in sync with the switch in api/stripe/webhook.ts → handleEvent().
// Subscribing to more than this just wastes deliveries (the handler no-ops and
// returns 200); subscribing to fewer silently breaks a billing transition.
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

function requireEndpointUrl(): string {
  const url = process.env.ENDPOINT_URL?.trim();
  if (!url) {
    console.error('ENDPOINT_URL is not set.');
    process.exit(1);
  }
  if (!url.startsWith('https://')) {
    console.error(`ENDPOINT_URL must be https:// — got: ${url}`);
    process.exit(1);
  }
  if (!url.endsWith('/api/stripe/webhook')) {
    console.error(
      `ENDPOINT_URL should end with /api/stripe/webhook (that's the route in api/stripe/webhook.ts) — got: ${url}`,
    );
    process.exit(1);
  }
  return url;
}

const endpointUrl = requireEndpointUrl();

const stripe = new Stripe(key);

function summary(lines: string[]) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, lines.join('\n') + '\n');
}

async function main() {
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = existing.data.find((e) => e.url === endpointUrl);

  let endpoint: Stripe.WebhookEndpoint;
  let created: boolean;

  if (match) {
    console.log(`Endpoint already exists for this URL (${match.id}) — reconciling events.`);
    endpoint = await stripe.webhookEndpoints.update(match.id, { enabled_events: EVENTS });
    created = false;
  } else {
    endpoint = await stripe.webhookEndpoints.create({
      url: endpointUrl,
      enabled_events: EVENTS,
      description: 'slashloop billing — grants/revokes workspace credits',
    });
    created = true;
    console.log(`Created endpoint ${endpoint.id}`);
  }

  const mode = endpoint.livemode ? 'LIVE' : 'TEST';
  const dashboard = endpoint.livemode
    ? `https://dashboard.stripe.com/webhooks/${endpoint.id}`
    : `https://dashboard.stripe.com/test/webhooks/${endpoint.id}`;

  console.log(`\nMode:     ${mode}`);
  console.log(`URL:      ${endpoint.url}`);
  console.log(`Status:   ${endpoint.status}`);
  console.log(`Events:   ${(endpoint.enabled_events ?? []).join(', ')}`);
  console.log(`Dashboard: ${dashboard}`);

  const lines = [
    '## Stripe webhook endpoint',
    '',
    `- **Mode:** ${mode}`,
    `- **Action:** ${created ? 'created' : 'already existed — events reconciled'}`,
    `- **URL:** \`${endpoint.url}\``,
    `- **Endpoint ID:** \`${endpoint.id}\``,
    `- **Status:** ${endpoint.status}`,
    '',
    '### Subscribed events',
    '',
    ...(endpoint.enabled_events ?? []).map((e) => `- \`${e}\``),
    '',
    '### Next step — signing secret',
    '',
    'The signing secret is **not printed here on purpose**: Actions logs and job',
    'summaries persist, and GitHub cannot mask a value generated at runtime.',
    '',
    `1. Open ${dashboard}`,
    '2. Reveal the **Signing secret** (`whsec_…`)',
    '3. Set it as `STRIPE_WEBHOOK_SECRET` in Vercel → Settings → Environment Variables',
    '4. Redeploy so the running functions pick up the new value',
    '',
    '> If `STRIPE_WEBHOOK_SECRET` was already set from a *different* endpoint, it',
    '> will not verify against this one — every delivery fails signature checks.',
    '> Replace it with the value from the endpoint above.',
  ];
  summary(lines);

  if (mode === 'LIVE') {
    console.warn('\n⚠️  This ran against a LIVE Stripe account, not test mode.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
