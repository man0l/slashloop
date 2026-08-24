# Product plan — UX improvements & new features

**Date:** 2026-08-21
**Status update (2026-08-21):** shipped from this plan — cost `cost` block on every metered tool response (provider-aware: Apify $ vs own-worker proxy GB); auto-deepen offer in `get_outlier_summary`; `generate_script`/`get_script` (5 app-promo formats); idea `dueAt` + `get_idea_queue` posting queue (also fixed unscoped `list_ideas`).
**Status update (2026-08-24):** shipped — **weekly outlier digest** (#1 new feature): `api/cron/digest.ts` (Mondays 09:00 UTC) builds + stores per-workspace digests and emails via Resend (`RESEND_API_KEY`, `DIGEST_FROM_EMAIL`); free `get_digest` tool serves the same payload to agents; opt-out via `update_settings.digestEnabled`. Migration `20260822090000_workspace_digest_columns.sql`.
**Status update (2026-08-24):** shipped — **track-your-own-account** (#2): `Source.isSelf` flags the owner's creator source (at most one per workspace). `create_source` / `update_source` accept it; gallery cards get `isSelf` (You badge + source filter). Scoring already uses the creator median, so those posts read as "you vs your baseline."

**Audience:** app builders / indie devs who make short-form TikTok videos (faceless app demos, POV, build-in-public) to market their own apps and earn from them. **Not** generic creators — no vidIQ-style channel analytics.

---

## Competitive scan (what similar apps ship)

| Product | Positioning | Stealable |
|---|---|---|
| **Virlo** ($49–199/mo) | Closest direct competitor — outliers, creators, sounds across TikTok/Reels/Shorts | niche tracking, credit metering; API gated to Enterprise (we *are* the API) |
| **1of10** ($29–69/mo) | Outlier research for YouTube | outlier multiples vs channel baseline, saved folders, AI idea gen |
| **ViewStats** | YT analytics (MrBeast) | niche trend **alerts**, collections, competitor tracking |
| **Foreplay / Motion / Atria** ($59–458/mo) | Ad-intel + creative strategy | swipe files w/ transcription, AI briefs from saved ads, auto-tagging by hook/angle, **weekly retros**, proactive decline alerts; Foreplay + Atria already ship MCP/API — the category is moving into Claude |
| **SendShort / Crayo / Short AI** ($19–59/mo) | Faceless video generators | prompt→script→auto-post series; templated viral formats |
| **TikTok Creative Center** | Free first-party Top Ads + trends | the free baseline our UX must beat |
| **MCP ecosystem** (Glama: ~20 TikTok MCPs) | fetchers, trend spikes, schedulers, one 7-agent video factory | none combine outlier detection → analysis → briefs → tracking as one loop |

Indie-dev threads (r/SaaS, faceless-account writeups) agree on the pain ranking: **cadence burnout, hook writing, and not knowing which video drove installs.**

**Read on slashloop today:** the core loop (track → actual-vs-median outlier scoring → Gemini analysis → hooks/briefs → boards) is differentiated and honest — nobody else combines it, and explainable multiples beat black-box virality scores. Gaps: it's 100% **pull** (no alerts), it doesn't close the loop to the **user's own account/app**, and cadence tooling is absent.

---

## Improvements to the existing surface

| # | Change | Why | Effort |
|---|---|---|---|
| 1 | **Auto-deepen top outliers** — when `get_outlier_summary` is mostly `estimated`, offer inline: "5–15 credits to verify these are real breakouts" (`deepen_baselines` + `rescore_sources`) | Best feature is invisible unless the user reads the skill; surface it at the moment of confusion | S |
| 2 | **Cost quote block in every mutating tool response** — consistent `cost` field so confirm-before-spend works in any client, not just via skill conventions | Skills enforce spend discipline by prose; move it into the protocol | S |
| 3 | **Mine sounds, not just hashtags/creators** — Apify results carry music metadata; add sound aggregation to `discover` + feed | Trending sounds drive half of TikTok reach; no direct competitor surfaces them next to outliers | M |

---

## New features (ranked)

### 1. Weekly outlier digest 🔴 (M)
Builders are shipping code, not running research sessions. Per-workspace cron (infra exists: `api/cron/`, `auto_analyze_cron.ts`) → "3 real breakouts in your niches this week + suggested hooks," as email and/or a single `get_digest` tool. The #1 retention feature — every alert-shipping competitor treats it as core.

### 2. Track-your-own-account mode 🔴 (S–M)
Let a builder add their own app's handle as a source (reuse `create_source` + Baseline/Score scoring; flag the source as `self`). Output: "your POV-demo format did 12× your median; day-in-the-life flopped." Turns slashloop from a research tool into *their* creative analytics.

### 3. Post log + weekly retro (M)
Pairs with #2: `log_post` (what I posted, which hook variation, link used) → weekly retro correlating posts with performance. Answers the question every indie thread asks and none can answer: **which video drove installs?** Even manual/paste-in correlation wins. Pattern to copy: Motion's weekly retro.

### 4. Full script generation from proven formats (S)
Hooks (2cr) and briefs (2cr) exist; add end-to-end faceless **scripts** templated on app-promo formats that work ("apps that feel illegal", problem→solution POV, build-in-public). New tool `generate_script`, ~2 credits, Gemini text pipeline (`briefs.ts` pattern) — mostly prompt work. SendShort/Crayo charge $19–59/mo largely for this.

### 5. Idea queue with due dates (S)
Cadence burnout is the #1 indie pain point. Ideas already exist as a model — add `dueAt` + a "what should I post today" tool. Not auto-posting; just the nudge.

### 6. Competitor-app watchlist benchmarking (M)
Rival apps' accounts are already trackable via `create_source`; add a compare view: their median views, posting cadence, and format mix vs the user's own-account stats (#2).

---

## Out of scope (deliberately)

- vidIQ/TubeBuddy-style channel analytics — wrong audience
- Auto-posting — TikTok publish API is gated; scheduling tools are a commodity
- Team seats / multi-seat — solo builders today
- Generic trend dashboards — TikTok Creative Center is free and fine at that
- Board sharing / public board links — cut from this round

---

## Suggested sequencing

1. **Quick wins:** #1–2 improvements (auto-deepen inline, cost quotes) + #4 scripts + #5 idea queue — all small, all visible
2. **Digest** (new #1) — retention engine
3. **Own-account mode** (new #2) → **post log + retro** (new #3) — the "my app" loop
4. **Sounds mining** + **competitor benchmarking** — differentiation polish
