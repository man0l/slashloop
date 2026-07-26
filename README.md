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
  lib/               # apify, gemini, spend-cap
remote/              # OAuth + Streamable HTTP handlers
api/                 # Vercel entrypoints (/mcp, /login, /oauth/consent, /health)
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
bun run db:push          # apply schema to Postgres
bun run remote:dev       # local: http://localhost:8788 (+ tunnel for OAuth)
# or: vercel --prod
```

### Routes
| Route | Purpose |
|---|---|
| `POST /mcp` | MCP endpoint (Bearer JWT) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 → Supabase AS |
| `GET /login` | Email/password sign-in |
| `GET /oauth/consent` | Consent UI |
| `GET /health` | Liveness |

---

## Required variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Postgres pooler (`?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL` | yes (migrations) | Supabase session-mode URL for `db:push` |
| `SUPABASE_URL` | yes (remote) | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_ANON_KEY` | yes (remote) | Supabase publishable key |
| `GEMINI_API_KEY` | **yes** | Powers gemini-native (primary) + gemini-text (fallback) analysis, hook variations, briefs |
| `APIFY_API_KEY` | for live TikTok | clockworks/tiktok-scraper + single-video download |
| `APIFY_SPEND_CAP_CENTS` | optional | Monthly Apify cap in cents (default 500 = $5) |
| `PUBLIC_URL` | yes (prod) | Public origin Claude reaches |

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
| `bun run db:push` | Apply Prisma schema to Postgres |
| `bun run db:generate` | Generate Prisma client |
| `bun src/scripts/auto_analyze_cron.ts` | External cron entry for nightly batch |
