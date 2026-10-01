// Shared facts about the Cloudflare Worker's env-var budget.
//
// The Worker runs on the Free plan, which caps `secret_text` + `plain_text`
// bindings at 64 (binding types like d1 / kv_namespace / r2_bucket have their
// own separate limits and are NOT counted against this cap). PR #96 tried to
// add D1_DAILY_READ_LIMIT as a 65th var and the deploy failed with
// Cloudflare code 10055 — after merge, because deploy-worker.yml only ran on
// pushes to master.
//
// Three scripts read this module so there is one list of names and one
// definition of "counted":
//   sync-worker-secrets.mjs   — pushes manifest values that are set in GitHub
//   prune-worker-secrets.mjs  — deletes the WORKER_EXCLUDED names from the Worker
//   check-worker-var-budget.mjs — fails the deploy before it exceeds 64
//
// Reads of the live Worker go through the Cloudflare API and only ever take
// binding NAMES and TYPES. Secret values are never fetched here.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKER_NAME = 'slashloop';

/** Free-plan ceiling for secret_text + plain_text bindings, combined. */
export const FREE_VAR_CAP = 64;

/** Binding types that count against FREE_VAR_CAP. */
const COUNTED_TYPES = new Set(['secret_text', 'plain_text']);

/**
 * GH secret/variable name → Worker env name. Everything the Worker should see
 * goes here explicitly — an allowlist, not a firehose: CI runtimes export
 * dozens of GITHUB_* and RUNNER_* vars that must never reach the Worker.
 */
export const MANIFEST = {
  // ── from repo/environment SECRETS ──
  // Stream credential for the video-recreate stepper. Preferred: a dedicated
  // Stream:Edit-only token in CLOUDFLARE_STREAM_TOKEN (least privilege). If it
  // is not set, the stepper falls back to CLOUDFLARE_API_TOKEN — which only
  // works when the deploy token's scope covers Stream.
  CLOUDFLARE_STREAM_TOKEN: 'CLOUDFLARE_STREAM_TOKEN',
  CLOUDFLARE_API_TOKEN: 'CLOUDFLARE_API_TOKEN',
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  SUPABASE_SECRET_KEY: 'SUPABASE_SECRET_KEY',
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  APIFY_API_KEY: 'APIFY_API_KEY',
  SCRAPER_PROXY_URL: 'SCRAPER_PROXY_URL',
  CRON_SECRET: 'CRON_SECRET',
  ALERT_EMAIL: 'ALERT_EMAIL',
  // Stripe: GH holds the live secret key under the name the stripe-setup
  // workflows already use (production environment). The rest are set directly
  // under their Worker names once real values exist in GitHub.
  STRIPE_SECRET_API_KEY: 'STRIPE_SECRET_KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',
  // Only the four fixed subscription Prices are read, and only through the
  // computed name in src/lib/stripe.ts priceEnv()/priceIdFor(). Credit packs
  // are not here: api/billing.ts builds inline price_data for them.
  STRIPE_PRICE_CREATOR_MONTH: 'STRIPE_PRICE_CREATOR_MONTH',
  STRIPE_PRICE_CREATOR_YEAR: 'STRIPE_PRICE_CREATOR_YEAR',
  STRIPE_PRICE_PRO_MONTH: 'STRIPE_PRICE_PRO_MONTH',
  STRIPE_PRICE_PRO_YEAR: 'STRIPE_PRICE_PRO_YEAR',
  STRIPE_TEST_SECRET_KEY: 'STRIPE_TEST_SECRET_KEY',
  STRIPE_TEST_WEBHOOK_SECRET: 'STRIPE_TEST_WEBHOOK_SECRET',
  STRIPE_TEST_PRICE_CREATOR_MONTH: 'STRIPE_TEST_PRICE_CREATOR_MONTH',
  STRIPE_TEST_PRICE_CREATOR_YEAR: 'STRIPE_TEST_PRICE_CREATOR_YEAR',
  STRIPE_TEST_PRICE_PRO_MONTH: 'STRIPE_TEST_PRICE_PRO_MONTH',
  STRIPE_TEST_PRICE_PRO_YEAR: 'STRIPE_TEST_PRICE_PRO_YEAR',
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
  R2_THUMB_BUCKET: 'R2_THUMB_BUCKET',
  R2_MEDIA_BUCKET: 'R2_MEDIA_BUCKET',
  // Presigned-S3 fallback data; on Workers the bindings win (src/lib/storage.ts
  // checks them first), so these only matter if the binding backend is off.
  R2_THUMB_PUBLIC_BASE: 'R2_THUMB_PUBLIC_BASE',
  WORKER_URL: 'WORKER_URL',
  SITE_URL: 'SITE_URL',
  PUBLIC_URL: 'PUBLIC_URL',
  // PG producer HMAC (SLA-16). URL has a code default; only id/secret need
  // bindings. PROXY_CHEAP_* stay on the VPS image, not this Worker — Free
  // accounts cap secrets+text at 64 and the Worker never scrapes.
  QUEUE_API_KEY_ID: 'QUEUE_API_KEY_ID',
  QUEUE_API_KEY_SECRET: 'QUEUE_API_KEY_SECRET',
};

/**
 * Names that must never be pushed to the Worker, and are pruned from it if
 * they are still there. Every entry needs a reason that survives review —
 * "we don't think this is read" is not enough, because most reads go through
 * a computed env name (see priceEnv(), envNumber()) and look dead to a grep.
 *
 *   R2_ACCOUNT_ID            No code reads it on any runtime. Its only repo
 *                            reference outside .env.example was this manifest.
 *   R2_ENDPOINT              Read by src/lib/storage.ts getR2Client(), which is
 *   R2_ACCESS_KEY_ID         unreachable on Workers: storageBackend() returns
 *   R2_SECRET_ACCESS_KEY     'r2-binding' whenever src/cf/env.ts registered the
 *                            R2 buckets, which both worker.ts entry paths do
 *                            before routing. The VPS image gets these from
 *                            GitHub separately (build-worker-image.yml).
 *   STRIPE_PRICE_PACK        priceIdFor() builds `${plan}_${interval}`, so the
 *   STRIPE_TEST_PRICE_PACK   only names it can resolve are
 *                            STRIPE_{,TEST_}PRICE_{CREATOR,PRO}_{MONTH,YEAR}.
 *                            api/billing.ts only calls it on the non-pack
 *                            branch; packs use inline price_data.
 *
 * Keep this set and the Worker's slot usage in the same place: adding a name
 * here is the cheapest way to buy headroom, and forgetting to is what the
 * check-worker-var-budget.mjs guard is there to catch.
 */
export const WORKER_EXCLUDED = new Set([
  'R2_ACCOUNT_ID',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'STRIPE_PRICE_PACK',
  'STRIPE_TEST_PRICE_PACK',
]);

/** Worker env names the manifest would push, minus the excluded ones. */
export function pushedWorkerNames() {
  return [...new Set(Object.values(MANIFEST))].filter((name) => !WORKER_EXCLUDED.has(name));
}

/** `vars` block of wrangler.jsonc — each key is a plain_text binding (counted). */
export function wranglerVarNames(file = join(repoRoot, 'wrangler.jsonc')) {
  // jsonc: strip line comments and trailing commas before parsing.
  const raw = readFileSync(file, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  const cfg = JSON.parse(raw);
  return Object.keys(cfg.vars ?? {});
}

/** Counted binding names (secret_text + plain_text) from a Worker settings doc. */
export function countedVarNames(settings) {
  const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
  return bindings
    .filter((b) => COUNTED_TYPES.has(b?.type) && typeof b?.name === 'string')
    .map((b) => b.name);
}

/**
 * The counted set this deploy will finish with: what the Worker has now, plus
 * every name the sync step and wrangler.jsonc would add that is not already
 * bound. Deliberately does NOT assume the prune step ran — over-counting is
 * the safe direction, because the caller reads the live settings after pruning
 * and a missed prune must fail the check rather than pass it. Returns sorted
 * names.
 */
export function projectCountedVarNames({ liveNames = [], addedNames = [] } = {}) {
  const live = new Set(liveNames);
  for (const name of addedNames) live.add(name);
  return [...live].sort();
}

/** True when a value means "placeholder, not configured" — never pushed. */
export function isPlaceholder(value) {
  return /^\[|SENSITIVE|placeholder|changeme|^your[-_]|^xxx$|example\.com|^todo\b/i.test(value);
}

/**
 * GET the Worker's settings: binding names and types only. Needs
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID. `fetchImpl` is injectable so
 * tests never touch the network.
 */
export async function readWorkerSettings({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN,
  worker = WORKER_NAME,
  fetchImpl = fetch,
} = {}) {
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/settings`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`GET workers/scripts/${worker}/settings failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (!body?.success) throw new Error(`unexpected settings response: ${JSON.stringify(body?.errors)}`);
  return body.result;
}