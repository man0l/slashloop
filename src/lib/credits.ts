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

export async function creditBalance(workspaceId: string): Promise<CreditBalance> {
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
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

  return db.$transaction(async (tx) => {
    const prior = await tx.creditLedger.findUnique({
      where: { workspaceId_refId: { workspaceId, refId: idempotencyKey } },
    });
    if (prior) {
      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
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
       WHERE id = ${workspaceId}
         AND "planCredits" + "packCredits" >= ${credits}
   RETURNING "planCredits", "packCredits"
    `;

    if (rows.length === 0) {
      const balance = await creditBalance(workspaceId);
      throw new InsufficientCreditsError(workspaceId, credits, balance.total);
    }

    const { planCredits, packCredits } = rows[0];
    await tx.creditLedger.create({
      data: {
        workspaceId,
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
  reason: 'usage_settlement' | 'call_failed' | 'adjustment' = 'call_failed',
): Promise<CreditBalance> {
  credits = Math.ceil(credits); // see debitCredits — Int columns, no float8 assignment cast
  if (credits <= 0) return creditBalance(workspaceId);

  return db.$transaction(async (tx) => {
    const prior = await tx.creditLedger.findUnique({
      where: { workspaceId_refId: { workspaceId, refId } },
    });
    if (prior) {
      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { planCredits: true, packCredits: true },
      });
      return { planCredits: ws.planCredits, packCredits: ws.packCredits, total: ws.planCredits + ws.packCredits };
    }

    const rows = await tx.$queryRaw<{ planCredits: number; packCredits: number }[]>`
      UPDATE "Workspace"
         SET "packCredits" = "packCredits" + ${credits}
       WHERE id = ${workspaceId}
   RETURNING "planCredits", "packCredits"
    `;
    const { planCredits, packCredits } = rows[0];
    await tx.creditLedger.create({
      data: {
        workspaceId,
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
