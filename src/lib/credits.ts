// ---------------------------------------------------------------------------
// Credit Ledger — the billing meter for metered MCP tools.
//
// 1 credit = $0.01. Two buckets on Workspace: planCredits (resets on billing
// renewal) and packCredits (purchased, never expire). Debits drain
// planCredits first so a plan-cycle reset never clobbers something the
// customer paid for separately.
//
// Every mutation is:
//   - atomic — a single conditional UPDATE, so concurrent tool calls from
//     the same agent (Vercel runs each MCP request as its own serverless
//     invocation) can't both read the same balance and both pass.
//   - idempotent — unique on CreditLedger[workspaceId, refId]. A retried
//     call with the same refId replays the prior result instead of
//     charging or refunding twice.
//
// This module intentionally does NOT read process.env.APIFY_SPEND_CAP_CENTS
// (see src/lib/spend-cap.ts) — that stays as a platform-wide circuit
// breaker against a bug or a misconfigured deploy. This module is the
// per-customer entitlement check.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import type { Prisma, Workspace } from '@prisma/client';
import { customerIdField, subscriptionIdField } from './stripe.js';
import { retentionCeiling } from './retention.js';

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly required: number,
    public readonly remaining: number,
  ) {
    super(`Insufficient credits: this action needs ${required}, workspace has ${remaining}.`);
    this.name = 'InsufficientCreditsError';
  }
}

// ---------------------------------------------------------------------------
// Per-tool pricing. Only metered (non-zero-cost) tools need an entry — every
// other tool (feed reads, list_*, boards, ideas, settings) is free. Kept in
// one place so a pricing change is a one-line diff, not a hunt through
// src/tools/.
// ---------------------------------------------------------------------------

export const CREDIT_COSTS = {
  /** refresh_source, per video returned by the scrape (not per new video —
   *  the Apify cost is incurred whether or not the video was already known). */
  refreshSourcePerVideo: 1.5,
  /** analyze_video / run_auto_analyze, per video analyzed. */
  analyzeVideo: 5,
  /** generate_hook_variations — a real Gemini text call. */
  generateHookVariations: 2,
  /** create_brief — a real Gemini text call. */
  createBrief: 2,
  /** suggest_sources — one Gemini text call to generate candidates. Verifying
   *  each candidate against Apify is billed separately, at
   *  refreshSourcePerVideo, per candidate (src/lib/suggestions.ts). */
  suggestSources: 3,
} as const;

export const FREE_TIER_PLAN_CREDITS = 300;

/** Default billing fields for a newly created workspace. */
export function freeTierGrant() {
  return { planKey: 'free', planCredits: FREE_TIER_PLAN_CREDITS, packCredits: 0 };
}

export interface CreditBalance {
  planCredits: number;
  packCredits: number;
  total: number;
}

/**
 * Billing is per-ACCOUNT, not per-workspace — a user's plan/credits live on
 * their primary (earliest-created) workspace, the same one Stripe billing
 * already exclusively resolves to (api/billing.ts, api/stripe/webhook.ts,
 * both via primaryWorkspaceByOwnerId in src/lib/workspaces.ts). Every credit
 * operation below resolves whatever workspace an action happened in to that
 * same primary workspace before touching a balance, so spending in a
 * secondary workspace draws on the account's real pool instead of that
 * workspace's own (post-migration, permanently empty) fields.
 *
 * Deliberately does NOT import primaryWorkspaceByOwnerId from
 * src/lib/workspaces.ts — that module imports freeTierGrant from this one,
 * and importing back would create a cycle. The lookup is only two small
 * queries; duplicating it here is cheaper than restructuring the module
 * boundary for it.
 */
async function resolveBillingWorkspaceId(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
  if (!ws?.ownerId) return workspaceId; // local/single-tenant workspace — no account to resolve to
  const primary = await db.workspace.findFirst({
    where: { ownerId: ws.ownerId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return primary?.id ?? workspaceId;
}

/**
 * Full-row version of resolveBillingWorkspaceId, for callers that already
 * have a Workspace object in hand and want to display the account's real
 * plan/credits (get_settings, retention ceiling checks) rather than the
 * active workspace's own — which, for a non-primary workspace, is
 * permanently 'free'/empty after the account-level migration. Takes the
 * ownerId straight off the object passed in, so it costs one query instead
 * of resolveBillingWorkspaceId's two.
 */
export async function resolveBillingWorkspace(workspace: Workspace): Promise<Workspace> {
  if (!workspace.ownerId) return workspace; // local/single-tenant — no account to resolve to
  const primary = await db.workspace.findFirst({
    where: { ownerId: workspace.ownerId },
    orderBy: { createdAt: 'asc' },
  });
  return primary ?? workspace;
}

export async function creditBalance(workspaceId: string): Promise<CreditBalance> {
  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId);
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: billingWorkspaceId },
    select: { planCredits: true, packCredits: true },
  });
  return { planCredits: ws.planCredits, packCredits: ws.packCredits, total: ws.planCredits + ws.packCredits };
}

/**
 * Atomically debit `credits`, plan bucket first. Throws
 * InsufficientCreditsError (balance left untouched) if the workspace can't
 * cover it. Idempotent on `idempotencyKey` — call it once per logical
 * operation (e.g. a fresh randomUUID() per tool invocation); a genuine
 * retry with the same key replays the original result rather than
 * double-charging.
 */
export async function debitCredits(
  workspaceId: string,
  credits: number,
  tool: string,
  idempotencyKey: string,
): Promise<CreditBalance> {
  // planCredits/packCredits are Postgres Int columns — there's no implicit
  // assignment cast from float8 back into Int, so a fractional debit would
  // fail the UPDATE at runtime. Round up here rather than trusting every
  // call site to have already done it (all current ones do, via
  // CREDIT_COSTS × Math.ceil, but this is the one place that has to be right).
  credits = Math.ceil(credits);
  if (credits <= 0) return creditBalance(workspaceId);

  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId);

  return db.$transaction(async (tx) => {
    const prior = await tx.creditLedger.findUnique({
      where: { workspaceId_refId: { workspaceId: billingWorkspaceId, refId: idempotencyKey } },
    });
    if (prior) {
      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: billingWorkspaceId },
        select: { planCredits: true, packCredits: true },
      });
      return { planCredits: ws.planCredits, packCredits: ws.packCredits, total: ws.planCredits + ws.packCredits };
    }

    // Single conditional UPDATE: only commits if the balance covers the
    // charge. LEAST/GREATEST split the debit across the two buckets,
    // draining planCredits before packCredits.
    const rows = await tx.$queryRaw<{ planCredits: number; packCredits: number }[]>`
      UPDATE "Workspace"
         SET "planCredits" = "planCredits" - LEAST("planCredits", ${credits}),
             "packCredits" = "packCredits" - GREATEST(0, ${credits} - "planCredits")
       WHERE id = ${billingWorkspaceId}
         AND "planCredits" + "packCredits" >= ${credits}
   RETURNING "planCredits", "packCredits"
    `;

    if (rows.length === 0) {
      const balance = await creditBalance(billingWorkspaceId);
      throw new InsufficientCreditsError(workspaceId, credits, balance.total);
    }

    const { planCredits, packCredits } = rows[0];
    await tx.creditLedger.create({
      data: {
        workspaceId: billingWorkspaceId,
        delta: -credits,
        bucket: 'plan',
        reason: 'tool_call',
        tool,
        balanceAfter: planCredits + packCredits,
        refId: idempotencyKey,
      },
    });

    return { planCredits, packCredits, total: planCredits + packCredits };
  });
}

/**
 * Grant credits back — a pre-authorized estimate came in above actual usage,
 * or a call failed after debiting. Refunds always land in packCredits (they
 * shouldn't inflate a plan-cycle counter). Idempotent the same way as
 * debitCredits: pass a refId distinct from the original debit's (e.g.
 * `${opId}:settle` or `${opId}:fail`) so a retried refund doesn't double-grant.
 */
export async function refundCredits(
  workspaceId: string,
  credits: number,
  tool: string,
  refId: string,
  reason: 'usage_settlement' | 'call_failed' | 'fetch_failed' | 'adjustment' = 'call_failed',
): Promise<CreditBalance> {
  credits = Math.ceil(credits); // see debitCredits — Int columns, no float8 assignment cast
  if (credits <= 0) return creditBalance(workspaceId);

  const billingWorkspaceId = await resolveBillingWorkspaceId(workspaceId);

  return db.$transaction(async (tx) => {
    const prior = await tx.creditLedger.findUnique({
      where: { workspaceId_refId: { workspaceId: billingWorkspaceId, refId } },
    });
    if (prior) {
      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: billingWorkspaceId },
        select: { planCredits: true, packCredits: true },
      });
      return { planCredits: ws.planCredits, packCredits: ws.packCredits, total: ws.planCredits + ws.packCredits };
    }

    const rows = await tx.$queryRaw<{ planCredits: number; packCredits: number }[]>`
      UPDATE "Workspace"
         SET "packCredits" = "packCredits" + ${credits}
       WHERE id = ${billingWorkspaceId}
   RETURNING "planCredits", "packCredits"
    `;
    const { planCredits, packCredits } = rows[0];
    await tx.creditLedger.create({
      data: {
        workspaceId: billingWorkspaceId,
        delta: credits,
        bucket: 'pack',
        reason,
        tool,
        balanceAfter: planCredits + packCredits,
        refId,
      },
    });
    return { planCredits, packCredits, total: planCredits + packCredits };
  });
}

/** Standard shape for the "can't afford this" tool response. Agents can't
 *  open a browser, so give them a working link to hand to their human. */
export function insufficientCreditsPayload(err: InsufficientCreditsError) {
  const upgradeUrl = process.env.UPGRADE_URL ?? 'https://slashloop.dev/upgrade';
  return {
    error: 'insufficient_credits',
    required: err.required,
    remaining: err.remaining,
    upgradeUrl,
    message: `This action needs ${err.required} credits; the workspace has ${err.remaining} remaining. Buy more credits or upgrade at ${upgradeUrl}.`,
  };
}

// ---------------------------------------------------------------------------
// Stripe-driven mutations (Phase 2) — docs/stripe-implementation-plan.md §3-5
//
// These take a Prisma.TransactionClient rather than opening their own
// transaction, unlike debitCredits/refundCredits above. The webhook handler
// (api/stripe/webhook.ts) wraps the StripeEvent idempotency-gate insert and
// exactly one of these calls in a single db.$transaction: if the gate insert
// fails on a duplicate event id, the mutation rolls back with it, and if the
// mutation throws, the gate insert rolls back too — so a transient failure
// leaves nothing committed and a Stripe retry reprocesses cleanly instead of
// silently no-op'ing against an already-seen event id.
//
// No separate idempotency check is needed inside these functions the way
// debitCredits/refundCredits check CreditLedger[workspaceId, refId] first —
// the caller's StripeEvent insert, in the same transaction, is the gate.
// ---------------------------------------------------------------------------

/** planKey -> the plan's monthly credit allotment (pricing-research.md §4c).
 *  Source of truth lives here, not in Stripe Price metadata, so a renewal
 *  reset can't drift from what the pricing page promises even if a Price's
 *  metadata is edited inconsistently in the Stripe dashboard. */
export const PLAN_CREDITS: Record<string, number> = {
  free: FREE_TIER_PLAN_CREDITS,
  creator: 3000,
  pro: 10000,
};

export interface TxSetPlanOptions {
  planKey: string;
  planCredits: number; // a reset (SET), not a delta — pass the full new allotment
  billingStatus?: 'active' | 'past_due' | 'canceled';
  periodStart?: Date | null;
  periodEnd?: Date | null;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string | null;
}

/**
 * Sets planKey/planCredits (a reset) plus whichever billing fields are
 * provided, and records the ledger row. Used for: initial subscription grant
 * (checkout.session.completed), renewal reset (invoice.paid, billing_reason
 * = subscription_cycle), and cancellation downgrade (customer.subscription.
 * deleted, with planKey: 'free').
 */
export async function txSetPlan(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  opts: TxSetPlanOptions,
  refId: string,
  reason: string,
): Promise<void> {
  const before = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { planCredits: true },
  });

  // Retention is plan-driven (docs/media-storage-plan.md, src/lib/retention.ts):
  // every plan change — upgrade or downgrade — snaps both retention windows
  // to the new plan's ceiling, so a downgrade also pulls a stale higher
  // value back down rather than leaving it grandfathered in.
  const ceiling = retentionCeiling(opts.planKey);
  const data: Prisma.WorkspaceUpdateInput = {
    planKey: opts.planKey,
    planCredits: opts.planCredits,
    thumbRetentionDays: ceiling,
    mediaRetentionDays: ceiling,
  };
  if (opts.billingStatus !== undefined) data.billingStatus = opts.billingStatus;
  if (opts.periodStart !== undefined) data.periodStart = opts.periodStart;
  if (opts.periodEnd !== undefined) data.periodEnd = opts.periodEnd;
  // Live/test mode have separate customer id spaces — write whichever
  // column matches the active STRIPE_MODE (see stripe.ts customerIdField()).
  if (opts.stripeCustomerId !== undefined) (data as Record<string, unknown>)[customerIdField()] = opts.stripeCustomerId;
  if (opts.stripeSubscriptionId !== undefined) (data as Record<string, unknown>)[subscriptionIdField()] = opts.stripeSubscriptionId;

  const updated = await tx.workspace.update({
    where: { id: workspaceId },
    data,
    select: { planCredits: true, packCredits: true },
  });

  await tx.creditLedger.create({
    data: {
      workspaceId,
      delta: updated.planCredits - before.planCredits,
      bucket: 'plan',
      reason,
      tool: null,
      balanceAfter: updated.planCredits + updated.packCredits,
      refId,
    },
  });
}

/** Additive packCredits grant (a purchased top-up pack). Never resets, never
 *  expires — see the module header. Used by checkout.session.completed for
 *  a mode:'payment' session. */
export async function txAddPackCredits(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  credits: number,
  refId: string,
  reason: string,
): Promise<void> {
  const updated = await tx.workspace.update({
    where: { id: workspaceId },
    data: { packCredits: { increment: credits } },
    select: { planCredits: true, packCredits: true },
  });
  await tx.creditLedger.create({
    data: {
      workspaceId,
      delta: credits,
      bucket: 'pack',
      reason,
      tool: null,
      balanceAfter: updated.planCredits + updated.packCredits,
      refId,
    },
  });
}

/** Plain field sync with no credit impact (subscription status/period
 *  changes, a failed-invoice flag) — no ledger row, since nothing about the
 *  balance changed. */
export async function txUpdateBillingFields(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  fields: Partial<{
    billingStatus: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
  }>,
): Promise<void> {
  // stripeCustomerId/stripeSubscriptionId here are logical names — map to
  // whichever column matches the active STRIPE_MODE before writing.
  const { stripeCustomerId, stripeSubscriptionId, ...rest } = fields;
  const data: Record<string, unknown> = { ...rest };
  if (stripeCustomerId !== undefined) data[customerIdField()] = stripeCustomerId;
  if (stripeSubscriptionId !== undefined) data[subscriptionIdField()] = stripeSubscriptionId;
  await tx.workspace.update({ where: { id: workspaceId }, data: data as Prisma.WorkspaceUpdateInput });
}

/** Workspace lookup by Stripe customer id, scoped to the active
 *  STRIPE_MODE — live and test each have their own customer id space (see
 *  customerIdField() in src/lib/stripe.ts). */
export function workspaceByCustomerId(customerId: string): Prisma.WorkspaceWhereUniqueInput {
  // Branch rather than build a computed key. TypeScript widens `{ [f()]: v }`
  // to `{ [x: string]: string }` even when f() returns a literal union, which
  // loses the guarantee that the key is one of the @unique columns — so the
  // previous `as` cast was asserting something the compiler had already said
  // it could not verify. These two branches type-check with no cast at all,
  // and adding a third id column would now be a compile error rather than a
  // silent lookup against a non-unique field.
  return customerIdField() === 'stripeTestCustomerId'
    ? { stripeTestCustomerId: customerId }
    : { stripeCustomerId: customerId };
}
