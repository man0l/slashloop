# slashloop-mcp

npm package: **[`slashloop-mcp`](https://www.npmjs.com/package/slashloop-mcp)** — local stdio MCP for viral short-form research (TikTok / Reels / Shorts, Gemini analysis, hooks & briefs).

This **git repo** also hosts the remote OAuth connector (not published to npm):

| Surface | Where | Install / run | Client |
|---|---|---|---|
| **npm package** | `src/` only | `npx slashloop-mcp` / Claude Code `env` block | Claude Code, Cursor, OpenCode |
| **Remote host** | `remote/` + `api/` + `vercel.json` | `bun run remote:dev` or Vercel | Claude Desktop Custom Connector |

```
src/                 # ← published on npm as slashloop-mcp
  index.ts           # stdio entry (bin: slashloop-mcp)
  register-tools.ts  # 32 tools (Stage 2: also used by remote)
  tools/
remote/              # NOT on npm — OAuth + Streamable HTTP
api/                 # NOT on npm — Vercel entrypoints
vercel.json          # NOT on npm
```

> **Stage 1 (remote):** OAuth + `whoami` only.  
> **Stage 2:** remote imports `registerAllTools()` from the package surface, scoped by JWT + Supabase RLS.

Package name stays **`slashloop-mcp`** (do not rename to `slashloop` on publish).

---

## Remote MCP (Claude Desktop + Supabase OAuth)

### 1. Supabase dashboard
1. **Auth → URL Configuration → Site URL** = your public connector URL  
   (e.g. `https://slashloop-….vercel.app` or a cloudflared tunnel).
2. **Auth → OAuth Server → Enable**. Authorization path = `/oauth/consent`.  
   Turn on **Dynamic client registration** (Claude self-registers).
3. **JWT signing → asymmetric (RS256)** so JWKS verification works.
4. **Email/password** enabled + a test user.

### 2. Env for remote
```bash
cp .env.example .env
# set SUPABASE_URL, SUPABASE_ANON_KEY
# optional: PUBLIC_URL, PORT (default 8788)
```

### 3. Local remote server
```bash
bun install
bun run remote:dev
# optional tunnel:
#   cloudflared tunnel --url http://localhost:8788
```

### 4. Deploy (Vercel)
Root of this repo has `vercel.json` + `api/*`. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the Vercel project, then deploy. Prefer a long-lived host (Railway / Fly / Render) if Streamable HTTP sessions flake on serverless.

### 5. Claude Desktop
**Settings → Connectors → Add custom connector** →  
`https://<your-public-url>/mcp`  
Complete login → consent → call **`whoami`**. Expect `{ sub, email, client_id }`.

| Route | Purpose |
|---|---|
| `POST /mcp` | MCP endpoint (Bearer JWT) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 → Supabase AS |
| `GET /login` | Email/password sign-in |
| `GET /oauth/consent` | Consent UI (`?authorization_id=…`) |
| `GET /health` | Liveness |

---

## Install in Claude Code / OpenCode (local stdio)

Both Claude Code and OpenCode read MCP server definitions from a JSON config file. The same `env` block pattern works for both.

### 1. Build the server

```bash
# from git clone, or: npm install -g slashloop-mcp
cd /path/to/slashloop
bun install
cp .env.example .env
# edit .env and fill in your keys (or skip — you can pass them via the env block below)
bun run db:push
bun run seed           # optional — seeds mock data so you can try the tools
```

### 2. Add to Claude Code

Edit `~/.claude/claude_code_config.json` (or your workspace `.mcp.json`) and add the `slashloop` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "slashloop": {
      "command": "bun",
      "args": ["/absolute/path/to/slashloop/src/index.ts"],
      "env": {
        "DATABASE_URL": "file:/absolute/path/to/slashloop/prisma/slashloop.db",
        "GEMINI_API_KEY": "your-gemini-key-here",
        "APIFY_API_KEY": "apify_api_xxxxxxxxxxxxxxxxxxxxx",
        "APIFY_SPEND_CAP_CENTS": "500",
        "APIFY_CAP_NOTIFICATION_HOOK": ""
      }
    }
  }
}
```

From the published package (after `npm i -g slashloop-mcp`), point `args` at the installed `src/index.ts` under the global/npm prefix, or use the `slashloop-mcp` bin if your client supports command-only servers.

> Gemini is the only AI provider — it powers both the primary `gemini-native` backend (video upload + native understanding) and the `gemini-text` fallback (text-only when video upload fails or yt-dlp is unavailable). No other AI provider key is required.

### 3. Add to OpenCode

Edit `~/.config/opencode/opencode.json` (or your project-level `.opencode.json`) and add the same `mcpServers` block — the schema is identical to Claude Code's.

### 4. Verify

Restart Claude Code / OpenCode, then ask the assistant: *"List slashloop tools"* or *"Call get_apify_spend_status."* You should see 32 tools registered.

## How the env block works

The MCP `env` block overrides whatever is in `.env` — it's the canonical way to inject secrets when running under an MCP client. This is preferred over `.env` because:

1. **No file path issues** — Claude Code spawns the MCP server from a fresh process with its own cwd. A relative `DATABASE_URL` in `.env` would resolve to the wrong place; an absolute path in the env block always works.
2. **No accidental commits** — secrets stay in your MCP client config, not the repo.
3. **Per-project overrides** — you can run multiple Slashloop instances (e.g. dev vs prod) by configuring different env blocks per workspace.

## Required variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | SQLite path. Use `file:` prefix + absolute path. |
| `GEMINI_API_KEY` | **yes** (for AI) | The only AI provider key needed. Powers GeminiNativeAnalyzer (primary: video upload + native understanding) AND GeminiTextAnalyzer (fallback: text-only when video upload fails or yt-dlp is unavailable). Also powers hook-variation and brief generation. |
| `APIFY_API_KEY` | for live TikTok scraping | apify/tiktok-scraper actor |
| `YOUTUBE_API_KEY` | future | YouTube Shorts (not yet wired) |
| `APIFY_SPEND_CAP_CENTS` | optional | Monthly Apify cap in cents. Default 500 ($5). Refuses calls + notifies on breach. |
| `APIFY_CAP_NOTIFICATION_HOOK` | optional | URL (POST) or shell command fired on cap breach |

## Tool inventory (32 tools)

| Module | Tools |
|---|---|
| Sources (6) | list_sources, get_source, create_source, update_source, delete_source, refresh_source |
| Feed (3) | get_feed, discover_search, get_outlier_summary |
| Video (3) | get_video, analyze_video, get_video_transcript |
| Hooks (3) | list_hooks, extract_hook, generate_hook_variations |
| Creative (11) | list_boards, get_board, create_board, save_to_board, export_board, list_ideas, create_idea, update_idea_status, create_brief, get_brief, export_brief |
| Settings (6) | get_usage, get_settings, update_settings, get_refresh_logs, run_auto_analyze, get_apify_spend_status |

## Quickstart for discovery testing

After install, the seeded discovery sources (looksmaxxing niche) are ready to refresh:

1. **Check spend headroom:** `get_apify_spend_status`
2. **Refresh a source:** `refresh_source` with one of the seeded source IDs (see below)
3. **View outliers:** `get_feed` with `minOutlierScore: 5`
4. **Analyze a winner:** `analyze_video` with the video ID
5. **Check spend again:** `get_apify_spend_status`

### Seeded discovery sources (looksmaxxing niche)

Created by `bun src/scripts/seed_discovery.ts`. 14 TikTok sources tagged `nicheTag: "looksmaxxing"`:

- keyword: `looksmax`, `mewing`, `mog`, `skincare`, `jawline`, `glow up`, `canthal tilt`
- hashtag: `#looksmax`, `#mewing`, `#mog`, `#skincare`, `#jawline`, `#glowup`, `#canthaltilt`

List them with: `list_sources` filtered by `nicheTag: "looksmaxxing"`.

## Spend cap behavior

The Apify spend cap is your testing guardrail:

- **Default:** $5/month (500 cents)
- **Enforced at:** every `refresh_source` call before the Apify request fires
- **On breach:** the call is refused, a `cap_breach` event is persisted to `UsageLog`, a stderr banner is printed, and the optional `APIFY_CAP_NOTIFICATION_HOOK` is fired
- **To raise:** edit `APIFY_SPEND_CAP_CENTS` in `.env` (or the MCP env block) and restart the client
- **To check:** call `get_apify_spend_status`

The cap resets on the first of each calendar month (monthly UsageLog aggregation).

## Architecture notes for MCP-aware developers

- **Short-lived process model:** Claude Code and OpenCode spawn a fresh MCP server per tool invocation. The failure-tracking counter (`Workspace.failureCountsJson`) is therefore DB-backed, not in-memory — otherwise the "2 consecutive failures → fallback" rule would reset on every call.
- **No long-running scheduler inside the MCP server:** `run_auto_analyze` is exposed as an MCP tool for on-demand runs. For nightly batch, use the standalone cron script: `bun src/scripts/auto_analyze_cron.ts`.
- **Batch discount:** `run_auto_analyze` (and the cron script) pass `batch: true` through to the analyzers, which selects `BATCH_COST_ESTIMATES` (50% Gemini discount via Gemini's Batch API). Single-video `analyze_video` uses interactive rates.
- **Schema is the contract:** Both analyzers (gemini-native, gemini-text) emit the same `VideoAnalysisData` Zod schema. Fields a backend can't fill return `null` with an `analysisBasis` tag, never a different shape.

## Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Start server with hot-reload (for development) |
| `bun run start` | Start server (production) |
| `bun run seed` | Seed mock data (6 sources, 52 videos, 3 analyses) |
| `bun src/scripts/seed_discovery.ts` | Seed the 14 looksmaxxing discovery sources |
| `bun src/scripts/auto_analyze_cron.ts` | External cron entry for nightly batch |
| `bun scripts/smoke.ts` | Smoke test (verify tools work after install) |
