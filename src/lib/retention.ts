// ---------------------------------------------------------------------------
// Media retention policy.
//
// Retention drives storage and egress, which makes it the same class of field
// as monthlyBudgetCents — and docs/stripe-implementation-plan.md §0.2 is
// explicit about what happens when a cost lever is user-writable and uncapped.
// So the value is per-workspace and writable, but every write goes through
// validateRetentionDays() and is rejected (not silently clamped) above the
// plan's ceiling.
// ---------------------------------------------------------------------------

/** Longest retention each plan may request, in days. */
export const PLAN_RETENTION_MAX: Record<string, number> = {
  free: 3,
  creator: 14,
  pro: 30,
};

const FALLBACK_PLAN_MAX = 3;
const DEFAULT_ABSOLUTE_MAX = 90;

/** Absolute server-side backstop, above any plan's allowance. */
export function absoluteMaxRetentionDays(): number {
  const n = Number(process.env.RETENTION_DAYS_MAX);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ABSOLUTE_MAX;
}

/** The effective ceiling for a workspace — the tighter of plan and backstop. */
export function retentionCeiling(planKey: string): number {
  const planMax = PLAN_RETENTION_MAX[planKey] ?? FALLBACK_PLAN_MAX;
  return Math.min(planMax, absoluteMaxRetentionDays());
}

export type RetentionValidation =
  | { ok: true; value: number }
  | { ok: false; ceiling: number; message: string };

/**
 * Validate a requested retention window. Rejects rather than clamps: a user who
 * asks for 365 and silently gets 3 will file a bug about missing thumbnails.
 */
export function validateRetentionDays(
  planKey: string,
  requested: number,
  label: string,
): RetentionValidation {
  const ceiling = retentionCeiling(planKey);

  if (!Number.isInteger(requested) || requested < 1) {
    return {
      ok: false,
      ceiling,
      message: `${label} must be a whole number of days >= 1 (got ${requested}).`,
    };
  }

  if (requested > ceiling) {
    return {
      ok: false,
      ceiling,
      message:
        `${label} of ${requested} days exceeds the maximum of ${ceiling} for the ` +
        `'${planKey}' plan. Upgrade for a longer window, or request ${ceiling} or fewer days.`,
    };
  }

  return { ok: true, value: requested };
}

/** Seed value for new workspaces. Env-driven so a deploy can change it without a migration. */
export function defaultRetentionDays(kind: 'thumb' | 'media'): number {
  const raw = kind === 'thumb'
    ? process.env.THUMB_RETENTION_DAYS_DEFAULT
    : process.env.MEDIA_RETENTION_DAYS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
