# Slashloop MCP — Pricing Research & Recommendation

Competitor scan + unit-economics model for monetizing the hosted Slashloop MCP
server. Research date: **2026-07-27**.

---

## 1. What Slashloop actually costs to run

Pulled from the code, not estimated. Sources: `src/lib/apify.ts`,
`src/lib/spend-cap.ts`, `src/analysis/`.

| Constant | Value | Where |
|---|---|---|
| Apify cost per scraped result | **$0.0037** (0.37¢) | `ESTIMATED_COST_PER_RESULT_CENTS` |
| Apify actor start fee | **$0.001** (0.1¢) | `ESTIMATED_ACTOR_START_COST_CENTS` |
| Single-video download ceiling | **$0.01** (1¢) | `ESTIMATED_DOWNLOAD_COST_CENTS` |
| Gemini native video analysis | **~$0.002/video** | `worklog.md`, gemini-native analyzer |
| Gemini text (hooks, briefs) | **~$0.001–0.003/call** | `gemini-text.ts` |

### Cost per tool call

| Tool | COGS | Notes |
|---|---|---|
| `refresh_source` (limit=30) | **$0.12** | `ceil(30 × 0.37¢ + 0.1¢)` = 12¢ |
| `discover_search` (limit=30) | **$0.12** | same Apify path |
| `analyze_video` | **~$0.012** | 1¢ download + ~0.2¢ Gemini |
| `extract_hook`, `generate_hook_variations`, `create_brief` | **~$0.002** | Gemini text only |
| `get_feed`, `list_*`, `get_video`, boards, ideas, settings | **~$0** | Postgres reads |

**Important cushion:** 0.37¢/result is Apify's *free-tier* rate, deliberately
used as a conservative upper bound for pre-authorization. On a paid Apify plan
the real rate is meaningfully lower, so true margins will run above the
modelled ones. Do not re-price downward until real invoices confirm the delta.

### Monthly COGS by usage persona

| Persona | Behaviour | Monthly COGS |
|---|---|---|
| Light (solo creator) | 3 sources, weekly refresh, 10 analyses | **~$1.60** |
| Medium (freelancer) | 10 sources, 2×/week, 50 analyses, briefs | **~$10.40** |
| Heavy (agency) | 30 sources, daily refresh, 200 analyses | **~$110** |

**The heavy row is the whole pricing problem.** A 30-source daily refresh is
$3.60/day of pure Apify spend. That is one sentence to an agent — *"refresh all
my sources"* — and it can be repeated all day. At a flat $49/mo, a single
motivated agency user is a **$60/month loss**.

---

## 2. Competitor scan

### 2a. agent-media.ai (requested specifically)

Adjacent, not a direct competitor — they *generate* UGC video, Slashloop
*researches* it. But their model is the cleanest reference for
credit-metered, CLI/agent-delivered pricing.

| Plan | Price | Credits |
|---|---|---|
| Creator | **$39/mo** | 3,900 |
| Pro | **$69/mo** | 6,900 |
| Pro Plus | **$129/mo** | 12,900 |

Mechanics worth copying:
- **Credit = $0.01, exactly.** 3,900 credits ÷ $39. Clean mental math, no
  obfuscation. Every tier holds the same ratio.
- **Billed per second of output**, 30 credits/sec → $3 per 10-second video. The
  unit is the *thing the customer wants*, not an internal API call.
- **Plan credits reset monthly; purchased packs never expire** while the
  account is active. Packs at $39.
- Tier gating is on *capability* (10s vs 15s video), not just volume.
- Marketed as "no hidden fees or surprise overages" — overage behaviour is not
  published on the pricing page.

### 2b. Virlo — the closest direct competitor

Same job to be done as Slashloop: outliers, creators and sounds across TikTok /
Reels / Shorts.

| Plan | Price | Credits | Seats |
|---|---|---|---|
| Starter | **$49/mo** | 2,000 | 1 |
| Pro | **$199/mo** | 12,000 | 3 |
| Enterprise | Custom | — | API access, dedicated AM |

- Credit ≈ **$0.0245** at Starter (2.5× agent-media's rate).
- Orbit Search = **50 credits/run ≈ $1.22 per search**.
- Custom Niche tracking = 1 credit per 1,000 videos + 2 credits per analysis.
- API access is gated to Enterprise — an opening, since Slashloop *is* the API.

### 2c. Wider market

| Product | Entry | Mid | Top | Unit |
|---|---|---|---|---|
| **Foreplay** | $59 (Basic, 10k API credits) | $175 (Workflow) | $458.99 (Agency) | ~15% off annual |
| **GetHookd** | $29 (50 cr, 1 seat) | $49 (150, 3) / $79 (400, 5) | $129 (800, 10) | credits + seats |
| **Creatify** | $33 (100 cr ≈ 20 videos) | $49 (200 cr ≈ 40) | — | no rollover |
| **Kalodata** | $45.90 | — | $99.90 | 7-day trial |
| **FastMoss** | Free | — | $79 | freemium |
| **Exolyt** | ~$49 | — | ~$275 | |

**Market consensus:** entry **$29–59**, mid **$79–199**, agency **$129–459**.
Credits are the near-universal unit. Seats are the near-universal tier gate.
Free trials are standard; permanent free tiers are rare outside FastMoss.

---

## 3. The MCP-specific problem nobody in that table has

Every competitor above sells a **UI that a human clicks**. Consumption is
bounded by human patience. Slashloop sells **tools an LLM calls**, and that
inverts the economics:

- A single agent conversation now averages **8–15 tool calls**, up from 2–3 in
  2024. Sessions of 100+ calls are common.
- An unthrottled MCP server can absorb **1,000+ calls/minute** from one agent.
  A mostly read-only Claude session has hit GitHub's 5,000/hour ceiling in
  about two minutes.
- A documented runaway loop ran **~$47,000 across 127,000 calls in ~8 hours**.
- **68%** of digital leaders reported major budget overruns on early agent
  deployments; nearly half blamed runaway tool loops.
- Seat-based pricing fell from **21% → 15%** share in a year as agent workloads
  broke the seat assumption. **84%** of enterprises saw >6% margin erosion from
  variable compute under flat fees.

Two consequences for Slashloop:

1. **Flat-rate unlimited is not survivable.** Slashloop's expensive tools sit
   behind paid third-party APIs (Apify), so a loop converts directly into
   invoice. Metering is mandatory, not a growth-stage nicety.
2. **Per-call card billing is arithmetically impossible.** Stripe is
   $0.30 + 2.9% per transaction; a $0.45 refresh would lose money on fees
   alone. The rule of thumb is payment cost must stay **under 10% of per-call
   revenue**. That rules out charging the card per tool call and points at
   **prepaid credits + monthly subscription** — Stripe touches the account
   once a month, metering happens internally for free.

Counter-pressure worth knowing: **budget-aware agents price-shop.** Google's
BATS research found they hit comparable accuracy with **40% fewer tool calls
and 31% lower cost**. In an agent marketplace the cheapest adequate tool wins
unless quality is programmatically legible. That argues for pricing *below*
Virlo and making result quality visible in tool responses.

---

## 4. Recommendation

**Hybrid: subscription base with included credits, per-tool metering, hard
per-workspace budget cap, optional top-up packs.** Freemium to land,
subscription to expand — the pattern that fits agents discovering tools
mid-task rather than humans reading a pricing page.

### 4a. Set credit = $0.01

Match agent-media exactly. It is the cleanest ratio in the market, and it
prices Slashloop visibly under Virlo's $0.0245.

### 4b. Per-tool credit costs

Priced for ~70–80% gross margin against the *conservative* COGS above; real
margin will be higher once paid-tier Apify rates apply.

| Tool | Credits | Price | COGS | GM |
|---|---|---|---|---|
| `get_feed`, `list_*`, `get_video`, boards, ideas, `whoami`, settings | **0** | free | ~$0 | — |
| `refresh_source` / `discover_search` | **1.5 / video** (45 @ 30 videos) | $0.45 | $0.12 | **73%** |
| `analyze_video` | **5** | $0.05 | $0.012 | **76%** |
| `extract_hook`, `generate_hook_variations`, `create_brief` | **2** | $0.02 | $0.002 | **90%** |

Charging per *video scraped* rather than per *call* is the key move: it makes
cost proportional to value delivered, and it means a `limit=5` probe costs 5%
of a `limit=100` sweep instead of the same flat fee. For reference, Virlo
charges **$1.22** for one Orbit Search; Slashloop's 30-video refresh at $0.45
is a third of that.

Read tools must stay free. They are ~$0 COGS, they are what an agent calls most
often while orienting, and metering them would teach agents to avoid Slashloop.

### 4c. Plans

| Plan | Price | Credits | Sources | Seats | Gates |
|---|---|---|---|---|---|
| **Free** | $0 | 300/mo | 2 | 1 | manual refresh only |
| **Creator** | **$29/mo** | 3,000 | 10 | 1 | scheduled weekly refresh |
| **Pro** | **$79/mo** | 10,000 | 30 | 3 | daily scheduled refresh, alerts |
| **Agency** | **$199/mo** | 30,000 | unlimited | 10 | webhooks, direct API, priority |

- **Top-up packs:** 5,000 credits for **$49**, never expire while the account
  is active (agent-media's pattern, and it is the right one — expiring packs
  generate support tickets and churn).
- **Overage:** default **hard-stop** at plan credits, with auto-top-up at
  **$0.012/credit** as an explicit opt-in. Default-stop is the honest choice
  when the caller is an agent that cannot consent to a surprise bill.
- **Annual:** 2 months free (~17%), slightly beating Foreplay's ~15%.

Worst-case margin check — Creator plan, credits burned entirely on the most
expensive tool: 3,000 credits ÷ 1.5 = 2,000 videos scraped × 0.37¢ = **$7.40
COGS on $29 revenue = 74% GM**. The floor holds even under adversarial usage,
which is exactly the property flat-rate pricing lacks.

Positioning: Free and Creator undercut every tool in the scan. Pro at $79 sits
in the gap between Virlo's $49 and $199. Agency at $199 matches Virlo Pro while
including the API access Virlo reserves for Enterprise — that is the sharpest
wedge available.

### 4d. Engineering work this implies

Ordered by how much money each one protects.

1. **Make the spend cap per-workspace and plan-derived.** Today
   `getApifyCapCents()` reads one global `APIFY_SPEND_CAP_CENTS` env var for
   every workspace, and the cap only covers Apify. It needs to become a
   per-workspace credit balance covering every metered provider. The
   architecture is already right — `assertApifyCap()` pre-authorizes,
   `recordApifySpend()` settles, `UsageLog` is the ledger. This is a
   generalization, not a rewrite, and it is the single highest-value change.
2. **Return cost and balance in every metered tool response.** Something like
   `{ creditsCharged: 45, creditsRemaining: 2955 }`. Budget-aware agents
   throttle themselves when cost is legible, and it prevents the surprise-bill
   failure mode entirely.
3. **Idempotent dedup.** A repeat `refresh_source` on the same source inside a
   short TTL should serve cached data and charge **0**. This is the single
   strongest defence against loop-driven cost, and it also makes the product
   feel faster.
4. **Never charge for failed calls.** Settle on success only; today the Apify
   estimate is recorded regardless of how the run resolves.
5. **Per-session and per-tool rate limits**, so one stuck agent cannot exhaust
   a month of credits in an afternoon.
6. **Reconcile estimates against real Apify invoices** monthly. Everything
   above is built on a free-tier upper bound; the real rate determines whether
   there is room to cut prices or add credits.

### 4e. Open questions for the founder

- **Do Reels and Shorts change the cost basis?** Both are still TODO in
  `apify.ts`. Instagram needs a different actor and Shorts needs the YouTube
  Data API, with different rates. Credit costs per platform may need to differ.
- **Free tier abuse.** 300 credits × unlimited signups is a real exposure with
  OAuth-only auth. Consider requiring a verified email domain or a card on file
  for the free tier.
- **Marketplace distribution.** Anthropic's Connectors Directory (841
  integrations as of July 2026) has no native billing rail for developers, so
  monetization stays self-hosted via Stripe regardless of listing there. Listing
  is a distribution decision, not a pricing one.

---

## Sources

- [agent-media.ai — Pricing](https://agent-media.ai/pricing)
- [Virlo — Pricing](https://virlo.ai/pricing)
- [Foreplay.co — Pricing](https://www.foreplay.co/pricing)
- [Foreplay Pricing 2026 — G2](https://www.g2.com/products/foreplay/pricing)
- [GetHookd — pricing comparisons](https://www.gethookd.ai/learn/zeely-ai-vs-creatify-ai-vs-gethookd-pricing-features-reviews/)
- [Creatify — Pricing](https://creatify.ai/pricing)
- [Kalodata Pricing (2026) — SimpTok](https://simptok.com/how-much-is-kalodata/)
- [FastMoss Review 2026 — SpotSaaS](https://www.spotsaas.com/blog/fastmoss-review-2026-features-pricing-and-tiktok-shop-analytics-guide)
- [14 Best TikTok Analytics Tools in 2026 — Virlo](https://virlo.ai/blog/best-tiktok-analytics-tools)
- [7 Best Short-Form Video Intelligence Tools in 2026 — Vellum](https://www.vellum.ai/blog/best-short-form-video-intelligence-tools)
- [How to Charge for an MCP Server in 2026 — UsageBox](https://usagebox.com/articles/how-to-charge-for-mcp-server-2026-per-call-subscription-x402)
- [Pricing MCP Tools When Your Customer Is a Machine — AgentPMT](https://www.agentpmt.com/articles/pricing-mcp-tools-unit-economics-when-your-customer-is-a-machine)
- [MCP Rate Limiting: Why Your AI Agent Needs Traffic Controls — MintMCP](https://www.mintmcp.com/blog/rate-limiting-with-mcp)
- [Rate Limiting in Virtual MCP Servers — Scalekit](https://www.scalekit.com/blog/rate-limiting-virtual-mcp-servers)
- [MCP Monetization for Tool Calling — Nevermined](https://nevermined.ai/blog/mcp-monetization-tool-calling)
- [Pay per event — Apify Documentation](https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event)
- [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
