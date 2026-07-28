# Stripe Implementation Plan

Turning the pricing model in [`pricing-research.md`](./pricing-research.md) into
working billing across two repos: **`man0l/slashloop`** (hosted MCP, Vercel) and
**`man0l/slashloop-site`** (landing page).

---

## 0. Three things in the current code that block billing

Found while reading the codebase. Each one has to be fixed before Stripe is
wired up, or billing will be wrong from day one.

### 0.1 The enforced budget is global, not per-workspace

`Workspace.monthlyBudgetCents` already exists (default 5000) and `get_usage`
reports against it (`src/tools/settings.ts:57`). But the code that actually
*enforces* anything — `getApifyCapCents()` in `src/lib/spend-cap.ts` — reads the
`APIFY_SPEND_CAP_CENTS` env var, which is one shared number for every customer
on the deployment.

So there are two competing notions of budget today, and the enforced one is not
the per-customer one. The per-workspace field is reported but toothless.

### 0.2 Users can raise their own limit

`update_settings` accepts `monthlyBudgetCents` as a user-writable parameter
(`src/tools/settings.ts:111,131`). The moment that field means *"what you paid
for"*, any user — or any agent acting for them — can call one MCP tool and grant
themselves unlimited credits.

**This field must become server-controlled and removed from the tool's input
schema.** It is the single most important change in this document.

### 0.3 The cap check races

`assertApifyCap()` does read-then-write: `findMany` → sum → (later)
`usageLog.create`. Nothing is atomic. Vercel runs each MCP request as a separate
serverless invocation, and agents fire tool calls in parallel — so N concurrent
`refresh_source` calls all read the same balance and all pass the check.

Harmless when it guards a $5 testing cap. Not harmless when it guards revenue.
Credit debits must become a single atomic conditional update.

---

## 1. Architecture: one writer for billing state

**The MCP server owns every piece of Stripe server logic.** The site is UI only.

```
slashloop-site (landing)          slashloop (MCP, Vercel)         Stripe
─────────────────────────         ───────────────────────         ──────
pricing page                  →   POST /api/billing/checkout  →   Checkout Session
                                                              ←   redirect to Stripe
account page                  →   GET  /api/billing/status
"manage billing" button       →   POST /api/billing/portal    →   Billing Portal
                                  POST /api/stripe/webhook    ←   events (source of truth)
                                       ↓
                                  Postgres: Workspace + CreditLedger
```

Why this split rather than putting checkout on the site:

- **Billing state has exactly one writer.** Two services writing subscription
  and credit rows is a reliable source of double-grants and drift.
- **The Stripe secret key never leaves the MCP deployment.** The site only holds
  the publishable key, if it needs one at all.
- The site is likely a static/edge-rendered landing page; it should not need a
  Postgres connection or Prisma.

**Shared identity:** both surfaces authenticate against the same Supabase
project. The site gets a Supabase session, sends the access token to the MCP's
billing endpoints, and the MCP verifies it with the existing
`verifySupabaseJwt()` (`remote/auth.ts`) — the same function `/mcp` already
uses. No new auth system.

---

## 2. Stripe dashboard setup

One **Product** per plan, with **Prices** carrying the credit allotment in
metadata so plan changes don't require a deploy.

| Product | Price | Interval | Price metadata |
|---|---|---|---|
| Creator | $29 | month | `plan_key=creator`, `credits=3000` |
| Creator | $290 | year | `plan_key=creator`, `credits=3000` |
| Pro | $79 | month | `plan_key=pro`, `credits=10000` |
| Pro | $790 | year | `plan_key=pro`, `credits=10000` |
| Credit pack | $49 | one-time | `pack_credits=5000` |

No Agency/Team product yet — `Workspace.ownerId` is a unique 1:1 with the
Supabase user, so there's no seat model to sell. See
[`pricing-research.md` §4c](./pricing-research.md#4c-plans) for what a
multi-seat tier would require before it can be re-added.

Also configure:
- **Billing Portal** — allow plan switching, payment-method update, cancellation.
- **Customer emails** for failed payments.
- **Smart Retries / dunning** on invoice failure.
- **Test mode keys first.** Everything below gets built and verified against
  test mode; live keys are a deploy-time swap.

Reading `credits` from Price metadata (rather than a hardcoded map in the
server) means pricing experiments are a dashboard edit.

---

## 3. Schema changes (`prisma/schema.prisma`)

```prisma
model Workspace {
  // ... existing fields ...

  // --- billing ---
  planKey              String    @default("free")    // free | creator | pro
  planCredits          Int       @default(300)       // resets each billing period
  packCredits          Int       @default(0)         // purchased, never expires
  billingStatus        String    @default("active")  // active | past_due | canceled
  periodStart          DateTime?
  periodEnd            DateTime?
  autoTopUp            Boolean   @default(false)
  stripeCustomerId     String?   @unique
  stripeSubscriptionId String?   @unique

  creditLedger CreditLedger[]
}

/// Append-only audit trail. Balance lives on Workspace for atomic debits;
/// this table explains how it got there.
model CreditLedger {
  id           String   @id @default(uuid())
  workspaceId  String
  delta        Int      // positive = grant, negative = debit
  bucket       String   // plan | pack
  reason       String   // subscription_renewal | pack_purchase | tool_call | refund | adjustment
  tool         String?  // e.g. refresh_source
  balanceAfter Int
  refId        String?  // Stripe event id, or per-call idempotency key
  createdAt    DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id])

  @@unique([workspaceId, refId])   // replay protection
  @@index([workspaceId, createdAt])
}

/// Stripe event id as PK — inserting twice fails, which is the idempotency check.
model StripeEvent {
  id          String   @id
  type        String
  payloadJson String
  processedAt DateTime @default(now())
}
```

`UsageLog` stays as-is. It records **COGS in cents** (what you pay Apify and
Google); `CreditLedger` records **revenue in credits** (what the customer pays
you). Keeping them separate is what lets you compute real gross margin per
workspace later.

**Two credit buckets, debited plan-first.** Plan credits reset on renewal; pack
credits persist. Draining the resetting bucket first is what makes
"packs never expire" actually true for the customer.

---

## 4. Atomic debit

The core primitive. Replaces the read-then-write in `spend-cap.ts`.

```ts
// src/lib/credits.ts
export async function debitCredits(
  workspaceId: string,
  credits: number,
  tool: string,
  idempotencyKey: string,
): Promise<{ ok: true; remaining: number } | { ok: false; remaining: number }> {
  // Single statement: check and decrement together. Plan bucket first.
  const rows = await db.$queryRaw<{ planCredits: number; packCredits: number }[]>`
    UPDATE "Workspace"
       SET "planCredits" = GREATEST(0, "planCredits" - ${credits}),
           "packCredits" = "packCredits" - GREATEST(0, ${credits} - "planCredits")
     WHERE id = ${workspaceId}
       AND "planCredits" + "packCredits" >= ${credits}
       AND "billingStatus" <> 'canceled'
 RETURNING "planCredits", "packCredits"
  `;
  if (rows.length === 0) return { ok: false, remaining: await balance(workspaceId) };
  // ... append CreditLedger row (unique on refId = idempotencyKey)
}
```

Rules that go with it:

- **Pre-authorize, then settle.** Debit an estimate before the Apify/Gemini
  call; refund the difference (a positive ledger row) if the actual result count
  came in lower. `refresh_source` frequently returns fewer videos than `limit`.
- **Never charge for failed calls.** Today the Apify estimate is recorded via
  `recordApifySpend()` regardless of how the run resolved. Refund on throw.
- **Dedup identical calls.** A repeated `refresh_source` on the same source
  inside a short TTL serves cached data and costs **0 credits**. This is the
  strongest single defence against agent loop costs, and it makes the product
  feel faster at the same time.

---

## 5. New routes on the MCP deployment

`api/mcp.ts` uses Web Standard `Request`/`Response` handlers, so the raw body is
just `await request.text()` — exactly what Stripe signature verification needs.
**Do not use `request.json()` on the webhook route**; parsing destroys the
signature.

### `POST /api/stripe/webhook`

```ts
const raw = await request.text();
const sig = request.headers.get('stripe-signature')!;
const event = await stripe.webhooks.constructEventAsync(
  raw, sig, process.env.STRIPE_WEBHOOK_SECRET!,
);
// INSERT into StripeEvent — a duplicate-key error means already processed, return 200.
```

Events to handle:

| Event | Action |
|---|---|
| `checkout.session.completed` | mode=`subscription` → bind `stripeCustomerId`/`stripeSubscriptionId` to the workspace via `client_reference_id`. mode=`payment` → grant `pack_credits` from Price metadata. |
| `customer.subscription.created` / `.updated` | Set `planKey`, `periodStart`, `periodEnd`, `billingStatus`. Handles upgrades and downgrades. |
| `invoice.paid` (`billing_reason=subscription_cycle`) | **Reset `planCredits`** to the plan allotment. This is the reliable renewal signal — not the subscription object. |
| `invoice.payment_failed` | `billingStatus = past_due`. Keep serving through a grace period; let Stripe dunning retry. |
| `customer.subscription.deleted` | Downgrade to `free`, `planCredits = 300`. **Leave `packCredits` intact** — they were paid for. |

**The webhook is the only thing that grants entitlement.** Never grant on the
checkout success redirect: the user can close the tab, and a client-controlled
URL is trivially forged.

### `POST /api/billing/checkout`
Auth: Supabase JWT. Resolves the workspace, creates or reuses the Stripe
Customer, creates a Checkout Session with `client_reference_id = claims.sub`,
returns `{ url }`.

### `POST /api/billing/portal`
Auth: Supabase JWT. Returns a Billing Portal session URL. This is what makes
cancellation, plan changes, and card updates someone else's problem.

### `GET /api/billing/status`
Auth: Supabase JWT. Returns `{ planKey, planCredits, packCredits, periodEnd,
billingStatus }` for the site's account page.

Each needs a `vercel.json` rewrite alongside the existing ones.

---

## 6. MCP tool changes

**Charge at the tool boundary, not inside `apify.ts`.** The customer is buying
`refresh_source`, not an Apify call — and some tools bill for Gemini work with
no Apify call at all.

| Tool | Credits |
|---|---|
| `refresh_source`, `discover_search` | 1.5 × videos returned |
| `analyze_video`, `run_auto_analyze` | 5 per video |
| `extract_hook`, `generate_hook_variations`, `create_brief` | 2 |
| everything else (feed, lists, boards, ideas, settings) | **0** |

Three MCP-specific behaviours that matter more here than in a normal SaaS:

1. **Return cost and balance in every metered response** —
   `{ creditsCharged: 45, creditsRemaining: 2955 }`. Budget-aware agents
   throttle themselves when cost is legible. This is the cheapest possible
   protection against runaway loops.

2. **Make the out-of-credits error actionable.** The caller is an agent that
   can't open a browser. Return a structured error carrying an upgrade URL so
   it can surface a working link to the human:
   ```json
   { "error": "insufficient_credits", "required": 45, "remaining": 12,
     "upgradeUrl": "https://slashloop.dev/upgrade?w=..." }
   ```

3. **Strip `monthlyBudgetCents` from `update_settings`** (§0.2) and replace the
   spend-cap surface: `get_apify_spend_status` becomes `get_billing_status`,
   reporting credits rather than an env-var cap. `get_usage` gains the credit
   balance.

Keep read tools free. They're ~$0 COGS, they're what an agent calls most while
orienting, and metering them just teaches agents to route around Slashloop.

---

## 7. What `slashloop-site` needs

**What it is today** (read from the repo, not assumed): a **Vite + React 18
SPA** with Tailwind v4, deployed on Vercel. Three source files —
`src/App.jsx` (426 lines), `main.jsx`, `index.css`. No router, no auth, no
Supabase client, no `vercel.json`, and **no server of any kind**. `App.jsx`
imports exactly one thing: React. It is a pre-launch waitlist page.

Two consequences:

- **It has no API routes, so it structurally cannot hold Stripe logic.**
  Creating a Checkout Session needs the secret key server-side. This turns §1's
  "MCP owns all Stripe logic" from a preference into the only option — which is
  the right outcome anyway. Vercel *would* let you add `/api` functions next to
  a Vite build; don't. That reintroduces the two-writers problem for no gain.
- **The waitlist form is cosmetic.** `src/App.jsx:155` is
  `onClick={() => email.includes("@") && setDone(true)}` — it shows a success
  state and stores nothing, anywhere. Every address submitted so far is gone.
  Unrelated to Stripe, worth fixing first: these are the people you'd sell the
  paid tiers to.

### Structural work (blocking everything else)

1. **Add a router** (`react-router-dom`) — the site is literally one page today
   and needs `/pricing`, `/login`, `/account`, `/billing/success`,
   `/billing/cancel`.
2. **Add `vercel.json` with an SPA rewrite** (`/(.*)` → `/index.html`).
   Without it every client route 404s on refresh or direct link — which is
   exactly how users arrive back from Stripe Checkout.
3. **Add `@supabase/supabase-js`** pointed at the same project as the MCP, plus
   a session provider. This is the shared identity that makes the MCP's
   `verifySupabaseJwt()` work for billing calls.

### Pages

4. **Pricing page** — three tiers (Free / Creator $29 / Pro $79), credit counts,
   and a "what a credit buys" table. Static.
5. **Login / signup** — Supabase email+password, matching what the MCP's
   `/login` already uses.
6. **Checkout button** → `POST {MCP_URL}/api/billing/checkout` with the Supabase
   access token as a Bearer header, then `window.location = url`.
7. **`/billing/success`** — shows "provisioning…" and polls
   `GET /api/billing/status` until `planKey` flips, because the webhook may land
   a beat after the redirect. **It must not grant anything itself.**
8. **`/billing/cancel`** — returns to pricing, no state change.
9. **Account page** — plan, credit balance, period end, and a "Manage billing"
   button → `POST /api/billing/portal`.

### Config

10. **Env vars** must use Vite's `VITE_` prefix to reach the client:
    `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MCP_URL`. Anything
    without the prefix is silently undefined in the browser.
11. **CORS** on the MCP's billing routes for the site's origin. `/mcp` itself
    doesn't need it.

### Copy

12. The hero and final CTA currently promise *"Free during beta. Founding
    loopers keep beta pricing when it ends"* (`src/App.jsx:407`). Launching paid
    tiers needs a decision on what that promise converts into — grandfathered
    Creator, a credit grant, or a discount — and the copy updated to match
    before the pricing page goes live.

Only the publishable Stripe key ever reaches the site, and only if it renders
Stripe Elements — with hosted Checkout it needs no Stripe key at all.

---

## 8. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | MCP only | API calls |
| `STRIPE_WEBHOOK_SECRET` | MCP only | Signature verification |
| `STRIPE_PRICE_*` | MCP | Price id per plan/interval (or look up by metadata) |
| `SITE_URL` | MCP | Checkout success/cancel redirects, CORS allowlist |
| `NEXT_PUBLIC_MCP_URL` (or equivalent) | site | Billing endpoint base |
| `APIFY_SPEND_CAP_CENTS` | MCP | **Keep it.** Repurposed as a platform-wide circuit breaker above per-workspace credits — protects you from a bug, not from a customer. |

---

## 9. Build order

Each phase is independently shippable and testable.

**Phase 1 — credit ledger, no Stripe. ✅ shipped** (`15fc005`). Schema,
`debitCredits()`/`refundCredits()`, per-tool charges, balance in responses,
`monthlyBudgetCents` removed from `update_settings`'s input schema. Everyone
seeds at the free tier. *This is the phase that actually protects
margin — it was worth shipping alone even before Stripe existed.*

**Phase 2 — Stripe test mode. ✅ code shipped, not yet configured or verified
live.** `api/stripe/webhook.ts` (signature verify + one-transaction
idempotency via `StripeEvent`, all five lifecycle events), `api/billing/
checkout|portal|status.ts`, `src/lib/stripe.ts`, `src/lib/cors.ts`, the
`txSetPlan`/`txAddPackCredits`/`txUpdateBillingFields` helpers in
`src/lib/credits.ts`. Type-checked against the real Prisma client; **not**
run against a live Stripe account — this sandbox has no Stripe test keys and
no way to apply the schema (§0's usual caveat: no `DATABASE_URL` here
either). Before this is real:
1. Create the products/prices in the Stripe dashboard (§2) with their
   `plan_key`/`credits`/`pack_credits` metadata.
2. `bun run db:push` against the actual Supabase Postgres instance —
   `CreditLedger` (Phase 1) and `StripeEvent` (Phase 2) both need to exist.
3. Populate `.env`'s `STRIPE_*` / `SITE_URL` vars from that dashboard.
4. Verify with `vercel dev` (**not** `bun run remote:dev` — that's a
   separate Node http server for the OAuth/MCP surface only, see
   `remote/dev.ts`'s own header comment; it has no route for anything under
   `/api/`, so `stripe listen --forward-to localhost:8788/...` 404s against
   it). Run `vercel dev`, then `stripe listen --forward-to
   localhost:3000/api/stripe/webhook` and `stripe trigger
   checkout.session.completed` (and the other four event types) — this is
   the step that actually exercises the code above; it hasn't happened yet.

**Phase 3 — site integration. ✅ shipped**, ahead of this doc's original
order — `man0l/slashloop-site` branch `claude/billing-scaffold`: router,
Supabase auth, pricing/login/account/billing-success/cancel pages, all built
against the `/api/billing/*` contract above. It was calling routes that
didn't exist yet when it shipped; they exist now.

**Phase 4 — lifecycle hardening.** Dunning and `past_due` grace, upgrade/
downgrade proration, cancellation, top-up packs, auto-top-up opt-in.

**Phase 5 — go live.** Live keys, live webhook endpoint, a real end-to-end
purchase, then reconcile a month of `UsageLog` COGS against `CreditLedger`
revenue to confirm the margins in the pricing doc survive contact with reality.

---

## 10. Test checklist

- [ ] Webhook replay (same event id twice) grants credits once
- [ ] Concurrent `refresh_source` calls cannot overdraw the balance
- [ ] Failed Apify run refunds the pre-authorized debit
- [ ] Renewal resets `planCredits` without touching `packCredits`
- [ ] Cancellation downgrades the plan but preserves `packCredits`
- [ ] `update_settings` can no longer alter credits or plan
- [ ] Out-of-credits returns a structured error with a working upgrade URL
- [ ] Card declined → `past_due` → grace period → recovery restores service
- [ ] Checkout completed with the tab closed still grants entitlement
