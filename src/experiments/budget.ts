import { ExperimentError, type Experiment } from './schema.js';

/** Matches Create.maxCredits upper bound in schema.ts. */
export const MAX_EXPERIMENT_CREDITS = 10_000;

export type CreditEstimate = {
  totalCredits: number;
  remainingCredits: number;
  workspaceCredits: number;
};

/**
 * Wallet (planCredits + packCredits) is the money check. Debits already drain
 * plan then pack. The experiment cap is only a runaway guard: an explicit
 * user-approved estimate may raise it so pack credits can cover generation
 * the auto-cap under-counted (slide fan-out).
 */
export function applyApprovedEstimate(e: Experiment, est: CreditEstimate): void {
  if (est.totalCredits > est.workspaceCredits) throw new ExperimentError(402, 'insufficient_budget');
  const needed = e.creditsCharged + est.totalCredits;
  if (needed <= e.maxCredits) return;
  if (needed > MAX_EXPERIMENT_CREDITS) throw new ExperimentError(402, 'experiment_budget_exceeded');
  e.maxCredits = needed;
}
