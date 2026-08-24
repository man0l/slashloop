# Product plan — UX improvements & new features

**Date:** 2026-08-21
**Status update (2026-08-21):** shipped from this plan — cost `cost` block on every metered tool response (provider-aware: Apify $ vs own-worker proxy GB); auto-deepen offer in `get_outlier_summary`; `generate_script`/`get_script` (5 app-promo formats); idea `dueAt` + `get_idea_queue` posting queue (also fixed unscoped `list_ideas`).
**Status update (2026-08-24):** shipped — **weekly outlier digest** (#1 new feature): `api/cron/digest.ts` (Mondays 09:00 UTC) builds + stores per-workspace digests and emails via Resend (`RESEND_API_KEY`, `DIGEST_FROM_EMAIL`); free `get_digest` tool serves the same payload to agents; opt-out via `update_settings.digestEnabled`. Migration `20260822090000_workspace_digest_columns.sql`.
**Status update (2026-08-24):** shipped — **track-your-own-account** (#2): `Source.isSelf` flags the owner's creator source (at most one per workspace). `create_source` / `update_source` accept it; gallery cards get `isSelf` (You badge + source filter). Scoring already uses the creator median, so those posts read as "you vs your baseline."
**Status update (2026-08-24):** shipped — **post log + weekly retro** (#3), **mine sounds** (improvement #3), **competitor watchlist** (#6). Studio page `/studio` + MCP `log_post` / `list_posts` / `get_weekly_retro` / `get_benchmark`. Sounds mined in discover + stored on Video. `Source.isCompetitor` for the watchlist.
**Status update (2026-08-24):** reworked — **Studio has no manual input**: the post log (#3) and the competitor flag (#6) are removed. The weekly retro reads the isSelf source's scraped feed directly (`LoggedPost` table dropped; retro rows carry caption/views/vs-median); the benchmark compares your account to every other tracked creator — no rival flag to set. Empty states resolve to one next step: track-your-account or resync (`refresh_source`), never data entry. `log_post` / `list_posts` deleted; tool count 51 → 49.

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
Rival apps' accounts are already trackable via `create_source`; add a compare view: their median views, posting cadence, and format mix vs the user's own-account stats (#2). *(Shipped 08-24, then simplified: every tracked creator is in the comparison set — no flag.)*

### 7. Film-this families — one tested concept per outlier (M for v1, L phased)
Extends analyze → hook chip → brief into a closed test loop. Lock a hypothesis (the invariant), spawn 3–4 Gen-1 hook variants, approve 2–3, film or render them, then score the children against **your** baseline via the isSelf feed before unlocking Gen 2 on the winning axis. One family per outlier; children never become families unless explicitly promoted. Pricing already names the step (brief + 4 hooks = 2 cr); charge per generation of proposals and per finished asset — never per axis. Full v1 spec below.

---

## Film-this families — v1 spec (feature #7)

Build it as a family that hangs off an analyzed Gallery card, not a new app. The card answers "what do I film today," not "design an experiment." v1 UI is three things: **hypothesis, beat sheet, hook row** — if a founder can't finish *Film this today* in one scroll on a laptop, it's too much.

### Pipeline

```
Gallery card (outlier)
  │ Analyze (Gemini)              5 cr  (exists)
  ▼
Analysis (hook, beats, format)
  │ Film this / Brief             2 cr
  ▼
FAMILY (Gen 0)   invariant + hypothesis + beat sheet + stopping rule
  │ Generate hooks                included in those 2 cr
  ▼
GEN 1            3–4 hook variants (text + first-frame spec)
  │ user picks 2–3 · film OR render slideshow
  ▼
CHILDREN         one asset per approved hook
  │ user posts
  ▼
RESULTS          which child beat the owner's baseline (isSelf feed)
  │ only then unlock Gen 2 (new axis, same family)
  ▼
GEN 2…
```

One family per outlier. Children never become new families unless explicitly "promote to concept."

### Objects

**Family** (the brief)

| Field | Notes |
|---|---|
| sourceVideoId | gallery card outlier |
| hypothesis | one editable sentence; cleared ⇒ Generate disabled — this is the invariant lock |
| invariant | audience · problem · argument · proof screen · CTA · destination (frozen chips in v1) |
| axis | `hook` only in v1 |
| beats[] | `{ t, role, spoken, onScreen, appSlot }` |
| stop | e.g. "4 hooks. If none beats hold after 3 posts, close." |
| status | draft → gen1 → posted → closed |

**Variant** (a child)

| Field | Notes |
|---|---|
| parentFamilyId / changedVariable / value | e.g. hook / contrarian |
| hookText + firstFrame | overlay spec or screenshot slot |
| status | proposed → approved → filmed\|rendered → posted → scored |
| assetUrl | mp4 or slide zip |
| ownPostId | auto-matched when the post lands on the owner's self-source feed (fallback: paste URL) |

MCP/CLI write the same objects. Dashboard is just the viewer.

### Screens

1. **Gallery card (entry):** unanalyzed cards unchanged; analyzed-without-family cards get one primary CTA `[Film this today →]` under the orange hook box; cards with a family show a chip instead (`3 hooks · 2 posted` → opens family). Card badges double as the index: none / hook line / brief / `3 variants` / `2 posted` / `C winning`. Gallery filters next to *Analyzed*: **Has brief / Has variants / Posted remakes.**
2. **Family panel:** right drawer (or panel under header) on `/gallery?video=<id>`, same max-width as Gallery. Left: sticky 9:16 source player with key-moment chips. Right: **Block A** hypothesis (editable, prefilled from analysis; frozen invariant chips: audience · problem · proof · CTA · format); **Block B** beat sheet (vertical rows from key moments; beat 0 dashed = "filled by each variant"; pins = invariant; empty app slot ⇒ "film this beat on your phone" not "render"); **Block C** Gen-1 row of 3–4 variant cards (~160px, text-on-color first frame) typed recognition / specific number / contrarian / demo-first; select 2–3 (top 2 pre-checked); footer shows cost before click: `2 selected · shot list free | render slideshow ~6 credits`; render disabled until an app slot is filled or they choose shot-list-only; **Block D** collapsed stopping rule, defaulted: "Stop this family if no selected hook beats your median hold rate after 3 posts."
3. **Children after approve:** winners collapse to child cards with status (`B filmed`, `C rendered · mp4`). Actions per child: copy caption + on-screen text · download mp4/slides · open on phone (QR to the file) · auto-marked posted via self-feed match (paste-URL fallback). No "generate 12 more"; one quiet link — *New test: proof beat* — appears only once ≥1 child is posted (Gen-2 unlock).
4. **Results (Phase 4 — stub now):** child row gains `6.1× your baseline · hold 41% vs family median`; family header reads "Hook C winning"; *Promote C* makes its hook text the new beat-0 invariant and opens Gen 2 with that lock. Until own-account data exists: "Posted · waiting on your stats" + manual winner pick.

### Credits

| Step | Credits | When |
|---|---|---|
| Analyze | 5 | exists |
| Brief + 4 hook variants | 2 | one charge — matches pricing table |
| Re-roll hooks (same family) | 2 | new gen-1; old proposals discarded, never mixed |
| Shot list (md/PDF + 9:16 overlay texts) | 0 | we want them filming |
| Slideshow render | per-render pack | Phase 3 |
| Re-render one child | render meter | only that child |

Do not charge per axis. Charge per generation of proposals and per finished asset.

### MCP / CLI parity

`/brief <27.4x>` → creates family, prints hypothesis + 4 hooks; `/brief <id> --approve B,C`; `/shotlist` → markdown + overlay texts for tonight; `/render --format slideshow --only B,C` (credits, files land at `/content/families/<id>/B.mp4`). Nightly agent job: scan niche → brief top 2 outliers → stop at Gen-1 proposals. Morning UI: two drafts waiting; founders pick hooks. Agents never auto-render the product space.

### Deliberately NOT in v1

No hooks × proofs × formats spreadsheet · no avatar/creator picker · no "make 50 variants" · no empty Gen 2/3 tabs · no auto-post to TikTok.

Happy path: hover card → Analyze → orange box → **Film this today** → edit one word of the hypothesis (hook cards already there) → uncheck A/D → download shot list or attach 2 screenshots → Render B, C → two files in the family → post → later the card reads **C winning**. That's the whole product; Gen 2 is a second pass on the same drawer once a winner exists.

---

## Out of scope (deliberately)

- vidIQ/TubeBuddy-style channel analytics — wrong audience
- Auto-posting — TikTok publish API is gated; scheduling tools are a commodity
- Team seats / multi-seat — solo builders today
- Generic trend dashboards — TikTok Creative Center is free and fine at that
- Board sharing / public board links — cut from this round

---

## Suggested sequencing

Shipped through 2026-08-24: improvements #1–3 and features #1–#6 (retro + benchmark reworked read-only over tracked data — see status updates above).

Next — feature #7 in phases:

1. **Families v1 (text-only)** — Family/Variant objects, Gen-1 hook row (2 cr, re-roll 2 cr), shot list export, gallery card badges + filters, `/brief` + `/shotlist` MCP parity
2. **Asset capture (Phase 2)** — app-slot screenshots attach to beats; enables the render path
3. **Slideshow render (Phase 3)** — per-render pack pricing lands with it; QR-to-file for children
4. **Results (Phase 4)** — children auto-scored vs owner baseline off the isSelf feed; Gen-2 unlock + promote-the-winner
