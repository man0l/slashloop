# Cloudflare full-backend end-state + cutover plan (Phase 4)

Consolidated target. `docs/cloudflare-migration.md` remains the Phase 1–3
runbook (copy/verify/flip detail); where the two disagree, this file wins.

## 1. End-state

One Worker serves all HTTP. D1 is the system of record. R2 holds media.
KV holds the shard directory. Cron Triggers replace Vercel Cron + pg_cron.
Supabase Auth stays only through the cutover soak (step 1), then a native
Cloudflare IdP (step 2). Scraping stays off-Worker until the
Containers-vs-VPS decision lands (open question 1).

## 2. What runs where

| Workload | Runs on | Entry / trigger |
|---|---|---|
| All HTTP routes (MCP, gallery, sources, videos, workspaces, studio, billing, digest-settings, stripe webhook, jobs drain, cron sweeps, pages) | Worker `slashloop` (`src/cf/worker.ts` fetch via `src/cf/router.ts`, mirrors `vercel.json` rewrites 1:1) | Custom domain (see §7); preview `https://<worker>.workers.dev` |
| `/.well-known/oauth-protected-resource`, `/login`, `/oauth/consent`, `/health`, `/`, 404 | Worker (static pages in `src/cf/router.ts`, ports of `remote/handlers.ts`) | same |
| Binding-backed media | Worker-only routes `/thumbs/*`, `/media/*` (`src/cf/media-routes.ts`) + R2 bindings | `R2_THUMBS` → `slashloop-thumbs`, `R2_MEDIA` → `slashloop-media` |
| VPS atomic batch bridge | Worker route `/internal/raw-batch` (`src/cf/internal.ts`) | VPS D1 HTTP client |
| Queue drain (was pg_cron `net.http_post` → `POST /api/jobs/analyze`) | Worker Cron Trigger `*/1 * * * *` → internal dispatch with `CRON_SECRET` (`src/cf/worker.ts` `scheduled`) | `api/jobs/analyze.ts` (claim → `src/worker/process-job.ts`) |
| Media-retention sweep (was `GET/POST /api/cron/media-retention`, Vercel daily `0 3 * * *`) | Worker Cron Trigger `0 3 * * *` | `api/cron/media-retention.ts` |
| Weekly digest (was `/api/cron/digest`, Vercel Mondays `0 9 * * 1`) | Worker Cron Trigger `0 9 * * 1` | `api/cron/digest.ts` |
| Relational data | D1 `slashloop`, binding `DB_SHARD0` (`wrangler.jsonc`), migrations in `prisma/d1-migrations/` | Shard router `src/store.ts` reads KV `SHARD_DIRECTORY`; second D1 only if DB nears ~7–10GB |
| Scraping (Playwright/impit/xbogus — stubbed out of the Worker bundle via `wrangler.jsonc` `alias` → `src/cf/node-only-stub.ts`), `discover` mines, long refresh/rescore/fetch | VPS worker (`src/worker/index.ts`, `worker/Dockerfile`) talking to D1 over Cloudflare HTTP API | `DB_DIALECT=sqlite` + `D1_ACCOUNT_ID`/`D1_DATABASE_ID`/`D1_API_TOKEN`; `WORKER_IDLE_MS=10000` |
| Future: job kinds `analyze`/`thumb`/`rescore` off the VPS | Queues + Cron drain, or Workflows, or Containers — **undecided** (open question 1) | — |

Vercel (`api/*`, `vercel.json` crons) and Supabase (Postgres, Auth, Storage,
pg_cron in `supabase/migrations/20260729080000_pgcron_drain_analyze_jobs.sql`
+ `20260803130000_pgcron_wake_for_stale_too_fresh.sql`, Vault
`cron_secret`/`worker_base_url`) are **legacy/rollback only** after the flip.

## 3. Auth path

- **Step 1 (cutover + soak): Supabase-compatible, no client change.**
  `api/mcp.ts` still calls `verifySupabaseJwt`; `remote/mcp-server.ts`
  `AUTHORIZATION_SERVER = ${SUPABASE_URL}/auth/v1`; the well-known document
  points at Supabase. No-`token` / bad-token → `401 invalid_token` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
  Keep the Supabase project alive (frozen) through the soak as the rollback target.
- **Step 2 (after soak): native IdP.** `workers-oauth-provider` + the `User`
  table becomes the authorization server; well-known flips to the Worker
  issuer; clients re-register/discover; then delete the Supabase project.
  Upstream choice (which provider backs `workers-oauth-provider`, key
  migration, session invalidation) is open question 2 — do not start step 2
  without it.

## 4. Cron / pg_cron / Vercel-Cron deletion order

Order matters — double drains bill real money (Apify/Gemini) and double sweeps
delete media twice:

1. Freeze: stop VPS worker, stop Vercel traffic (maintenance page / accept window).
2. Final `--copy` + `--verify` (`VERIFY: ok`), point Worker at D1 (already bound).
3. Keep Worker Cron Triggers **disabled/commented** during the freeze copy so
   the drain does not process live (billable) jobs mid-copy.
   Note: `wrangler.jsonc` currently lists all three crons as active with a
   comment saying they are disabled — treat the comment as intent; the
   integrator must comment them out for the freeze and re-enable per §8 / the
   checklist.
4. Flip traffic + Stripe webhook (§7), redeploy VPS on D1 creds, verify live
   (checklist §1–8).
5. Re-enable Worker crons **one at a time**, in this order: `*/1` drain →
   observe one queue cycle → `0 3` retention → `0 9 * * 1` digest (Monday or
   forced dry-run first).
6. Only after the Worker drain is confirmed owning the queue: `cron.unschedule('drain-analyze-jobs')`
   on Supabase (covers both pg_cron migrations above), then disable/remove the
   two Vercel Crons (`vercel.json` `crons` + dashboard).
7. After soak: delete Supabase project (kills Postgres/pg_cron/Vault/Auth/Storage
   in one stroke). Decommission Vercel project last so the rollback target
   exists longest.

Never run the Worker drain and pg_cron drain against the same queue
simultaneously outside a minutes-long handover window.

## 5. Rollback procedure

Valid any time before the Supabase project is deleted (both legacy sides stay
frozen and intact during the soak):

1. Point MCP clients / site API base back at `https://mcp.slashloop.dev`
   (Vercel). No client re-registration (auth never changed in step 1).
2. Point the Stripe webhook endpoint(s) back at
   `https://mcp.slashloop.dev/api/stripe/webhook` (test + live).
3. Redeploy the VPS worker on `DATABASE_URL` (Postgres) — unset `DB_DIALECT`/`D1_*`,
   restore `WORKER_IDLE_MS=3000`, re-enable pg_cron schedule if un-scheduled.
4. Re-enable Vercel Crons; disable Worker Cron Triggers.
5. Trigger: any failed hard gate in `docs/cf-cutover-checklist.md`
   (health, 401 semantics, tenant isolation, queue exactly-once, Stripe test e2e,
   media round-trip), or error-rate / credit-spend anomaly in the first hour.

Writes made to D1 after the flip do **not** copy back — rollback loses them.
That is accepted; the soak window is kept short for exactly this reason.

## 6. Secrets checklist

Worker (`wrangler secret put <NAME>`, same names as `.env.example`):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CRON_SECRET`, `PUBLIC_URL`, `SITE_URL`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY` (+ `OPENROUTER_VIDEO_MODEL`/`MODE`),
`APIFY_API_KEY`, `APIFY_SPEND_CAP_CENTS`, `RESEND_API_KEY`, `ALERT_EMAIL`,
`STRIPE_MODE`, `STRIPE_SECRET_KEY`/`STRIPE_TEST_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`/`STRIPE_TEST_WEBHOOK_SECRET`,
`STRIPE_PRICE_*`/`STRIPE_TEST_PRICE_*`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE`/`R2_THUMB_PUBLIC_BASE`,
`SCRAPER_*`/`WORKER_URL`/`WORKER_ACTIVE` as applicable.
`GALLERY_LINK_SECRET` lives **only** on Cloudflare (never in GitHub).

VPS post-flip (replaces `DATABASE_URL`): `DB_DIALECT=sqlite`,
`D1_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_API_TOKEN` (D1 Write), plus existing
scraper/LLM keys. CI syncs via `scripts/sync-worker-secrets.mjs` from GitHub
secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` + manifest names).

Legacy (do not delete until §4 step 7): Supabase Vault `cron_secret`,
`worker_base_url`.

## 7. Custom-domain + Stripe-webhook-URL flip checklist

- Worker custom domain / route attached (dashboard or `wrangler triggers`);
  `PUBLIC_URL` secret = canonical origin; `curl /health` on the domain is the
  first live gate. (Live today is `https://mcp.slashloop.dev/mcp`; the old
  `slashloop.app` host has no DNS — `src/lib/cors.ts` marks it retired. Do not
  point anything at `slashloop.app`.)
- MCP clients / site API base → Worker domain (or `workers.dev` preview for
  the dry run only).
- Stripe dashboard (test + live): webhook endpoint →
  `https://<worker-domain>/api/stripe/webhook`; confirm signing secret matches
  `STRIPE_[TEST_]WEBHOOK_SECRET` (see `.github/workflows/stripe-webhook-setup.yml`
  default `https://mcp.slashloop.dev/api/stripe/webhook`); run the test-mode e2e
  in the checklist before touching live.
- `SITE_URL` (slashloop-site origin) unchanged — Checkout/Portal redirects +
  billing CORS still key off it.
- D1 id (`e1caee8f-…`) and KV id (`dccd06ab-…`) in `wrangler.jsonc` are already
  filled — the `d1 create` / `kv namespace create` step in the old runbook is done.
  D1 location is Western Europe (`weur` in `wrangler.jsonc`), not `eu`.

## 8. Cron re-enable order (after flip)

`*/1` drain → verify queue cycle → `0 3` retention → `0 9 * * 1` digest.
Full per-step gates: `docs/cf-cutover-checklist.md`.
