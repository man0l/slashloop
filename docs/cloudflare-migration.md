# Cloudflare Workers + D1 migration — runbook

Target state (Phase 1–3): the HTTP API + MCP endpoint run as **one Cloudflare
Worker**, the relational data lives in **D1**, media stays on **R2**, Supabase
Auth keeps issuing JWTs until the Phase 4 auth swap, and the VPS scraper keeps
running — talking to D1 over Cloudflare's HTTP API.

Cost outcome: Supabase + its 6GB egress bill disappear; Workers Paid ($5/mo)
replaces them. D1 has no egress charges.

## CI/CD (the normal path)

Deploys run through **GitHub Actions** (`.github/workflows/deploy-worker.yml`):
every push to `master` (or a manual `workflow_dispatch`) installs deps, syncs
the Worker's environment from GitHub (`scripts/sync-worker-secrets.mjs` — every
manifest-listed secret/variable that is **set** in GitHub is pushed to the
Worker; unset ones are left as-is, never deleted), applies pending D1
migrations, and runs `wrangler deploy`.

Required GitHub secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit +
D1:Edit), `CLOUDFLARE_ACCOUNT_ID`, plus the manifest names in
`scripts/sync-worker-secrets.mjs` (GEMINI/STRIPE/APIFY/R2/SUPABASE/...).
`GALLERY_LINK_SECRET` is the one value that lives only on Cloudflare
(generated at migration time — `wrangler secret put GALLERY_LINK_SECRET` to
rotate).

## What was built

| Piece | Where |
|---|---|
| Worker entry (fetch + scheduled/crons) | `src/cf/worker.ts` |
| Router mirroring `vercel.json` rewrites | `src/cf/router.ts` |
| D1 binding + Prisma registration (per isolate) | `src/cf/env.ts` |
| Shard-ready data facade (`db`, `rawBatch`, dialect) | `src/store.ts` |
| SQLite Prisma schema (derived — never hand-edit) | `prisma/schema.sqlite.prisma` via `src/scripts/sync-sqlite-schema.ts` |
| D1 migrations (initial: `0001_init.sql`) | `prisma/d1-migrations/` |
| Data migration script | `src/scripts/migrate-supabase-to-d1.ts` |
| Node-only dep stubbing (impit/playwright/…) | `alias` in `wrangler.jsonc` → `src/cf/node-only-stub.ts` |

Key runtime facts (why the code looks the way it does):

- **D1 has no interactive transactions.** `debitCredits`/`refundCredits` run as
  ONE atomic `rawBatch` (guarded ledger INSERT + conditional UPDATE); the Stripe
  webhook uses gate-insert → handler → compensating-delete. The Postgres paths
  keep their `$transaction`s (dialect-branched via `dbDialect()`).
- **No `FOR UPDATE SKIP LOCKED`** — D1 is single-writer, so the single-statement
  `UPDATE … WHERE id = (SELECT …) RETURNING *` claim is atomic by itself.
- **Dates bind as ISO text** (`…T…+00:00`); retention sweeps use `julianday()`
  which parses that format — `--verify` checks it after the copy.
- **D1 caps bound params at ~98/query** — big `IN` lists are chunked
  (`src/store.ts chunked`, retention cascade uses re-selection subqueries).
- **Two generated Prisma clients coexist**: `@prisma/client` (Postgres, VPS +
  scripts) and `src/generated/sqlite` (Workers). Never `instanceof` Prisma
  error classes — use `isUniqueViolation()` (two class identities).
- **Playwright/impit/xbogus never enter the Worker bundle** (wrangler `alias`
  stubs); scraping stays on the VPS worker. Warm-signer is not exported from
  the scrapers barrel anymore.

## Cutover steps

1. **One-time setup** (after `wrangler login`):
   ```bash
   bunx wrangler d1 create slashloop --location eu        # copy the database_id into wrangler.jsonc
   bunx wrangler kv namespace create SHARD_DIRECTORY      # copy the id into wrangler.jsonc
   bun run db:d1:migrate                                   # apply prisma/d1-migrations remotely
   bunx wrangler secret put SUPABASE_URL                   # then every secret from .env (see list below)
   bunx wrangler deploy                                    # workers.dev preview URL
   curl https://<worker>.workers.dev/health                # smoke check
   ```
2. **Dry-run the copy against the preview** (safe: reads Supabase, writes D1;
   app traffic still on Vercel/Supabase):
   ```bash
   D1_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… \
     bun src/scripts/migrate-supabase-to-d1.ts --plan
   D1_… bun src/scripts/migrate-supabase-to-d1.ts --copy
   D1_… bun src/scripts/migrate-supabase-to-d1.ts --verify
   ```
   `--verify` must print `VERIFY: ok` (counts + date-format + workspace sample).
3. **Freeze**: pause the VPS worker (`docker compose stop`), and stop Vercel
   traffic (deploy a maintenance page or just accept a short window —
   `vercel.json` rewrites can be pointed at a static page).
4. **Final copy**: re-run `--copy` + `--verify` (INSERT OR IGNORE — idempotent).
5. **Flip**:
   - Point slashloop.app's API base / MCP client URLs at the Worker URL (or
     attach the Worker to a custom domain via `wrangler triggers`/dashboard).
   - Update the Stripe webhook endpoint URL (dashboard → test + live).
   - Redeploy the VPS worker with D1 credentials instead of `DATABASE_URL`:
     ```env
     DB_DIALECT=sqlite
     D1_ACCOUNT_ID=…
     D1_DATABASE_ID=…
     D1_API_TOKEN=…
     WORKER_IDLE_MS=10000     # was 3000 — D1 has no cheap per-3s polling
     ```
     (`src/db.ts` picks the D1 HTTP client up from those vars automatically.)
6. **Verify live**: `/health`, login → gallery loads, one `refresh_source` +
   `analyze_video` end-to-end, hook test, `get_usage`, and confirm the next
   Monday digest + a scrape-alert dry run.
7. **Rollback** (any time before Supabase is deleted): point clients back at
   Vercel/Supabase — both stay frozen and intact during the soak period.

## Secrets to set on the Worker (`wrangler secret put <NAME>`)

Same names as `.env.example`: `SUPABASE_URL`, `CRON_SECRET`, `PUBLIC_URL`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `APIFY_API_KEY`,
`APIFY_SPEND_CAP_CENTS` (if used), `RESEND_API_KEY`, `ALERT_EMAIL`,
`STRIPE_MODE`, `STRIPE_SECRET_KEY`/`STRIPE_TEST_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`/`STRIPE_TEST_WEBHOOK_SECRET`,
`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (VPS S3 path — the
Worker itself uses the R2 bindings), `R2_PUBLIC_BASE`/`R2_THUMB_PUBLIC_BASE`,
`SCRAPER_*` / `WORKER_URL` / `WORKER_ACTIVE` as applicable.

## Phase 4 (after soak)

- Swap Supabase Auth → Cloudflare-native IdP (`workers-oauth-provider` +
  the `User` table), then delete the Supabase project.
- Move `analyze`/`thumb`/`rescore` job kinds into Workers (Cron Triggers +
  Queues), then decommission the VPS.
- Sharding kicks in only if/when the DB nears ~7GB: create a second D1 DB,
  copy by `ownerId`, flip the KV shard directory — ops task, no code rewrite.
