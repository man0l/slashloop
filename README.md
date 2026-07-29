# slashloop

Hosted MCP server for viral short-form video research — track TikTok / Reels /
Shorts sources, find outlier videos, run Gemini video analysis, and turn
winners into hooks, ideas, and creative briefs.

**Remote HTTP MCP only** (no local stdio server): deployed on Vercel,
authenticated via Supabase OAuth2. API keys (Gemini, Apify) live server-side,
so installers never handle them.

| Surface | Where | Install | Client |
|---|---|---|---|
| **Claude plugin** | `claude-plugin/` | `/plugin marketplace add man0l/slashloop` | Claude Code |
| **Connector** | deployed host | add `…/mcp` as a custom connector | Claude Desktop, Cowork, claude.ai |

Live endpoint: **https://slashloop-connector-seven.vercel.app/mcp**

```
src/
  register-tools.ts  # 32 tools, shared with the remote host
  tools/             # sources, feed, video, hooks, creative, settings
  analysis/          # Gemini native + text analyzers
  lib/               # apify, gemini, spend-cap, storage, media, retention
remote/              # OAuth + Streamable HTTP handlers
api/                 # Vercel entrypoints (/mcp, /login, /oauth/consent, /health)
api/billing/         # Checkout, Billing Portal, status — called by slashloop-site
api/stripe/          # Webhook — the only thing that grants/revokes credits
api/cron/            # Scheduled jobs (media retention sweep)
claude-plugin/       # Claude Code plugin (skills + bundled remote MCP)
vercel.json
```

---

## Install

### Claude Code (plugin — skills + remote MCP)
```
/plugin marketplace add man0l/slashloop
```
Then install `slashloop` from the Marketplace tab. The plugin registers the
remote MCP server and the `/slashloop:track`, `/slashloop:discover` skills.
On first tool call, complete the Supabase OAuth login in the browser.

### Claude Desktop / Cowork / claude.ai (connector)
Settings → Connectors → Add custom connector →
`https://slashloop-connector-seven.vercel.app/mcp` → log in → consent.
All 32 tools are then available; ask in plain language
("track tiktok creator @x", "find outlier videos about Y").

> The `/slashloop:track` / `/discover` slash shortcuts are Claude Code plugin
> skills. In Desktop/Cowork you don't need them — the connector exposes every
> tool directly.

---

## Self-host (Vercel + Supabase)

### 1. Supabase dashboard
1. **Auth → URL Configuration → Site URL** = your public connector URL.
2. **Auth → OAuth Server → Enable**. Authorization path = `/oauth/consent`.
   Turn on **Dynamic client registration**.
3. **JWT signing → asymmetric (RS256)**.
4. **Email/password** enabled + a user.

### 2. Env
```bash
cp .env.example .env
# DATABASE_URL + DIRECT_URL (Supabase Postgres pooler)
# SUPABASE_URL, SUPABASE_ANON_KEY
# GEMINI_API_KEY, APIFY_API_KEY, APIFY_SPEND_CAP_CENTS, PUBLIC_URL
```

### 3. Run / deploy
```bash
bun install
bun run remote:dev       # local: http://localhost:8788 (+ tunnel for OAuth)
# or: vercel --prod
```

### Schema changes

**Production schema is managed by Supabase migrations, not Prisma.** SQL files
in `supabase/migrations/` are applied by the Supabase GitHub integration on
merge to the default branch. `prisma/schema.prisma` stays the source of truth
for the *client* (types + query builder) — the two must be kept in sync by
hand.

To add a schema change:
```bash
# 1. Edit prisma/schema.prisma
# 2. Generate the delta SQL (offline — no DB connection needed):
bunx prisma migrate diff \
  --from-schema-datamodel <schema.prisma before your change> \
  --to-schema-datamodel   prisma/schema.prisma \
  --script > supabase/migrations/$(date +%Y%m%d%H%M%S)_your_change.sql
# 3. Harden it with IF NOT EXISTS guards (see the billing migration for the
#    pattern), commit, and merge — Supabase applies it.
bun run db:generate      # refresh the Prisma client
```

### Media storage (optional)

TikTok cover images and MP4s are persisted to Supabase Storage so the feed
doesn't render broken images once the source CDN's signed URLs expire, and so
re-analysis can skip a paid Apify call. Leave `SUPABASE_SECRET_KEY` unset and
the entire path no-ops — everything else works as before.

Setup is one step: set `SUPABASE_SECRET_KEY` and `CRON_SECRET` in Vercel. Two
buckets are needed — **`thumbs` (public)** and **`media` (private, 100MiB)**.
`supabase/migrations/*_media_storage_buckets.sql` creates them if they're
absent, so a fresh project or a local `supabase start` comes up ready.

> That migration is **create-only** (`ON CONFLICT DO NOTHING`) — it never
> reconciles a bucket that already exists, so dashboard settings are safe from
> it. It also downgrades a permissions failure on `storage.buckets` to a
> `NOTICE` rather than blocking a deploy. Between the two, a green migration
> isn't proof the buckets exist with the right settings; check the dashboard
> once. The one that matters is **`media` must be private** — public would
> mean an open mirror of scraped video.

Retention defaults to 3 days and is a per-workspace setting changed via the
`update_settings` tool, capped per plan. Supabase has no object lifecycle
rules, so expiry runs as a daily Vercel Cron (`/api/cron/media-retention`).

Full design, including the later phases: [`docs/media-storage-plan.md`](./docs/media-storage-plan.md).

> ⚠️ **Do not run `bun run db:push` against production.** It bypasses the
> migration history entirely and will drift from what Supabase has applied.
> It exists only for throwaway local databases. Likewise, never run
> `prisma migrate` — it maintains its own `_prisma_migrations` table that
> Supabase knows nothing about.

### Routes
| Route | Purpose |
|---|---|
| `POST /mcp` | MCP endpoint (Bearer JWT) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 → Supabase AS |
| `GET /login` | Email/password sign-in |
| `GET /oauth/consent` | Consent UI |
| `GET /health` | Liveness |
| `POST /api/billing/checkout` | Bearer JWT. Creates a Stripe Checkout Session, returns `{ url }` |
| `POST /api/billing/portal` | Bearer JWT. Creates a Billing Portal session, returns `{ url }` |
| `GET /api/billing/status` | Bearer JWT. Returns `{ planKey, planCredits, packCredits, periodEnd, billingStatus }` |
| `POST /api/stripe/webhook` | Stripe signature, not JWT. The only thing that grants/revokes credits |

The three `/api/billing/*` routes carry CORS for `SITE_URL` (the landing site's
origin); `/mcp` and `/api/stripe/webhook` don't need it — neither is called
from a browser.

---

## Required variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Postgres pooler (`?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL` | local only | Supabase session-mode URL (port 5432). Prisma's datasource declares it, but production schema changes go through `supabase/migrations/` — see "Schema changes" above |
| `SUPABASE_URL` | yes (remote) | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_ANON_KEY` | yes (remote) | Supabase publishable key |
| `GEMINI_API_KEY` | **yes** | Powers gemini-native (primary) + gemini-text (fallback) analysis, hook variations, briefs |
| `APIFY_API_KEY` | for live TikTok | clockworks/tiktok-scraper + single-video download |
| `APIFY_SPEND_CAP_CENTS` | optional | Monthly Apify cap in cents (default 500 = $5) |
| `PUBLIC_URL` | yes (prod) | Public origin Claude reaches |
| `SITE_URL` | yes (billing) | Origin of slashloop-site — Checkout/Portal redirects + CORS |
| `STRIPE_SECRET_KEY` | yes (billing) | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | yes (billing) | Signs `/api/stripe/webhook` requests |
| `STRIPE_PRICE_CREATOR_MONTH` / `_YEAR`, `STRIPE_PRICE_PRO_MONTH` / `_YEAR` | yes (billing) | Subscription Price ids, each with `plan_key`/`credits` metadata |
| `STRIPE_PRICE_PACK` | yes (billing) | One-time credit-pack Price id, with `pack_credits` metadata |
| `SUPABASE_SECRET_KEY` | optional | Enables media storage. Unset = the whole media path no-ops |
| `STORAGE_THUMB_BUCKET` / `STORAGE_MEDIA_BUCKET` | optional | Bucket names (default `thumbs` public, `media` private) |
| `THUMB_RETENTION_DAYS_DEFAULT` / `MEDIA_RETENTION_DAYS_DEFAULT` | optional | Seeds new workspaces only (default 3). Retention itself is a per-workspace setting |
| `RETENTION_DAYS_MAX` | optional | Absolute ceiling above any plan's allowance (default 90) |
| `CRON_SECRET` | yes (storage) | Guards `/api/cron/*`. The retention sweep deletes media — it must not be publicly invocable |

See `docs/stripe-implementation-plan.md` for the full Stripe dashboard setup
(products, prices, webhook registration). Schema is applied by the Supabase
migration in `supabase/migrations/` on merge; the remaining manual step is
populating the env vars above from a real Stripe account.

---

## Tool inventory (32 tools)

| Module | Tools |
|---|---|
| Sources (6) | list_sources, get_source, create_source, update_source, delete_source, refresh_source |
| Feed (3) | get_feed, discover_search, get_outlier_summary |
| Video (3) | get_video, analyze_video, get_video_transcript |
| Hooks (3) | list_hooks, extract_hook, generate_hook_variations |
| Creative (11) | list_boards, get_board, create_board, save_to_board, export_board, list_ideas, create_idea, update_idea_status, create_brief, get_brief, export_brief |
| Settings (6) | get_usage, get_settings, update_settings, get_refresh_logs, run_auto_analyze, get_apify_spend_status |

---

## Spend cap behavior

- **Default:** $5/month (500 cents)
- **Enforced at:** every `refresh_source` (and single-video download) before the Apify request fires
- **On breach:** the call is refused, a `cap_breach` event is persisted to `UsageLog`, and the optional `APIFY_CAP_NOTIFICATION_HOOK` fires
- **To check:** call `get_apify_spend_status`
- Resets on the first of each calendar month.

---

## Architecture notes

- **Stateless per request:** each `POST /mcp` builds a fresh transport + `McpServer` (`WebStandardStreamableHTTPServerTransport`), scoped by the JWT `sub` via `runWithUser` (AsyncLocalStorage) → `requireWorkspace()`.
- **Multi-tenant:** every workspace lookup keys off the Supabase user id; JWT scoping isolates users.
- **Failure tracking is DB-backed** (`Workspace.failureCountsJson`) so the "2 consecutive failures → fallback" rule survives across stateless requests.
- **No in-process scheduler:** `run_auto_analyze` is an on-demand tool; for nightly batch use `bun src/scripts/auto_analyze_cron.ts`.
- **Batch discount:** `run_auto_analyze` passes `batch: true` → `BATCH_COST_ESTIMATES` (50% Gemini Batch API discount). Single `analyze_video` uses interactive rates.
- **Schema is the contract:** both analyzers emit the same `VideoAnalysisData` Zod schema; unfilled fields are `null` with an `analysisBasis` tag.

---

## Scripts

| Script | Purpose |
|---|---|
| `bun run remote:dev` | Local remote host with watch (port 8788) |
| `bun run seed` | Seed mock data |
| `bun run db:push` | ⚠️ Local/throwaway DBs only — never production (see "Schema changes") |
| `bun run db:generate` | Generate Prisma client |
| `bun src/scripts/auto_analyze_cron.ts` | External cron entry for nightly batch |
