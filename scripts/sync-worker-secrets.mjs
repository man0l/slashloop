// Sync GitHub-provided environment variables → Cloudflare Worker secrets.
//
// GitHub is the source of truth (repo secrets/variables + the `production`
// environment the workflow runs under). This script runs INSIDE the deploy
// workflow, reads whatever the manifest lists from process.env, and pushes
// the non-empty ones with `wrangler secret bulk`.
//
// Semantics ("if set"):
//   • GH value present and non-empty → pushed (overwrites the Worker's).
//   • GH value absent/empty → Worker secret LEFT AS-IS (never deleted).
//   • Names not in the manifest are never touched.
//
// One-time setup lives on the Cloudflare side (`wrangler secret put`) only
// for values that have no GH home (e.g. the generated GALLERY_LINK_SECRET).

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GH secret/variable name → Worker env name. Everything the Worker should see
 * goes here explicitly — an allowlist, not a firehose: CI runtimes export
 * dozens of GITHUB_* and RUNNER_* vars that must never reach the Worker.
 */
const MANIFEST = {
  // ── from repo/environment SECRETS ──
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  SUPABASE_SECRET_KEY: 'SUPABASE_SECRET_KEY',
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  APIFY_API_KEY: 'APIFY_API_KEY',
  SCRAPER_PROXY_URL: 'SCRAPER_PROXY_URL',
  PROXY_CHEAP_API_KEY: 'PROXY_CHEAP_API_KEY',
  PROXY_CHEAP_API_SECRET: 'PROXY_CHEAP_API_SECRET',
  R2_ACCESS_KEY_ID: 'R2_ACCESS_KEY_ID',
  R2_SECRET_ACCESS_KEY: 'R2_SECRET_ACCESS_KEY',
  CRON_SECRET: 'CRON_SECRET',
  ALERT_EMAIL: 'ALERT_EMAIL',
  // Stripe: GH holds the live secret key under the name the stripe-setup
  // workflows already use (production environment). The rest are set directly
  // under their Worker names once real values exist in GitHub.
  STRIPE_SECRET_API_KEY: 'STRIPE_SECRET_KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',
  STRIPE_PRICE_CREATOR_MONTH: 'STRIPE_PRICE_CREATOR_MONTH',
  STRIPE_PRICE_CREATOR_YEAR: 'STRIPE_PRICE_CREATOR_YEAR',
  STRIPE_PRICE_PRO_MONTH: 'STRIPE_PRICE_PRO_MONTH',
  STRIPE_PRICE_PRO_YEAR: 'STRIPE_PRICE_PRO_YEAR',
  STRIPE_PRICE_PACK: 'STRIPE_PRICE_PACK',
  STRIPE_TEST_SECRET_KEY: 'STRIPE_TEST_SECRET_KEY',
  STRIPE_TEST_WEBHOOK_SECRET: 'STRIPE_TEST_WEBHOOK_SECRET',
  STRIPE_TEST_PRICE_CREATOR_MONTH: 'STRIPE_TEST_PRICE_CREATOR_MONTH',
  STRIPE_TEST_PRICE_CREATOR_YEAR: 'STRIPE_TEST_PRICE_CREATOR_YEAR',
  STRIPE_TEST_PRICE_PRO_MONTH: 'STRIPE_TEST_PRICE_PRO_MONTH',
  STRIPE_TEST_PRICE_PRO_YEAR: 'STRIPE_TEST_PRICE_PRO_YEAR',
  STRIPE_TEST_PRICE_PACK: 'STRIPE_TEST_PRICE_PACK',
  // Runtime billing switch (live|test) — set as a GitHub VARIABLE. Unset
  // leaves whatever the Worker currently has.
  STRIPE_MODE: 'STRIPE_MODE',
  // ── from repo/environment VARIABLES ──
  SUPABASE_URL: 'SUPABASE_URL',
  APIFY_SPEND_CAP_CENTS: 'APIFY_SPEND_CAP_CENTS',
  MEDIA_SIGNED_URL_TTL_SECONDS: 'MEDIA_SIGNED_URL_TTL_SECONDS',
  OPENROUTER_VIDEO_MODEL: 'OPENROUTER_VIDEO_MODEL',
  OPENROUTER_VIDEO_MODE: 'OPENROUTER_VIDEO_MODE',
  OPENROUTER_VIDEO_MAX_TOKENS: 'OPENROUTER_VIDEO_MAX_TOKENS',
  PROXY_TRAFFIC_CAP_GB: 'PROXY_TRAFFIC_CAP_GB',
  R2_ACCOUNT_ID: 'R2_ACCOUNT_ID',
  R2_ENDPOINT: 'R2_ENDPOINT',
  R2_THUMB_BUCKET: 'R2_THUMB_BUCKET',
  R2_MEDIA_BUCKET: 'R2_MEDIA_BUCKET',
  // Presigned-S3 fallback data; on Workers the bindings win (src/lib/storage.ts
  // checks them first), so these only matter if the binding backend is off.
  R2_THUMB_PUBLIC_BASE: 'R2_THUMB_PUBLIC_BASE',
  WORKER_URL: 'WORKER_URL',
  SITE_URL: 'SITE_URL',
  PUBLIC_URL: 'PUBLIC_URL',
};

// Values that mean "placeholder, not configured" — never pushed.
const PLACEHOLDER = /^\[|SENSITIVE|placeholder|changeme|^your[-_]|^xxx$|example\.com|^todo\b/i;

const payload = {};
const skipped = [];
for (const [ghName, workerName] of Object.entries(MANIFEST)) {
  const value = process.env[ghName];
  if (!value || value.trim() === '' || PLACEHOLDER.test(value)) {
    skipped.push(ghName);
    continue;
  }
  payload[workerName] = value;
}

const names = Object.keys(payload);
console.log(`syncing ${names.length} secrets: ${names.join(' ')}`);
if (skipped.length > 0) console.log(`not set in GitHub (left as-is on the Worker): ${skipped.join(' ')}`);

if (names.length === 0) {
  console.log('nothing to sync');
  process.exit(0);
}

const file = join(tmpdir(), `worker-secrets-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(payload));
try {
  execFileSync('bunx', ['wrangler', 'secret', 'bulk', file, '--name', 'slashloop'], { stdio: 'inherit' });
  console.log('secrets synced.');
} finally {
  rmSync(file);
}
