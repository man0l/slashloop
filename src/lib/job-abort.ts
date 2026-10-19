import { AsyncLocalStorage } from 'node:async_hooks';

// The worker races each claimed job against a wall-clock timer. Rejecting the
// race does not stop the loser: before this, a timed-out refresh kept retrying
// TikTok fetches in the background (and then failJob'd the row a second time).
// The job-level AbortSignal + deadline ride AsyncLocalStorage so the network
// layer can stop without threading a parameter through every scraper.

interface JobBudget {
  signal: AbortSignal;
  deadlineMs: number;
}

const budgetScope = new AsyncLocalStorage<JobBudget>();

export function withJobBudget<T>(signal: AbortSignal, deadlineMs: number, fn: () => Promise<T>): Promise<T> {
  return budgetScope.run({ signal, deadlineMs }, fn);
}

/** The enclosing job's abort signal, or undefined outside a budgeted job. */
export function currentJobSignal(): AbortSignal | undefined {
  return budgetScope.getStore()?.signal;
}

/** True once the job-level timer has fired for the job running in this scope. */
export function jobAborted(): boolean {
  return budgetScope.getStore()?.signal.aborted === true;
}

/** Wall-clock ms left in the enclosing job's budget (Infinity outside one). */
export function jobBudgetRemainingMs(): number {
  const b = budgetScope.getStore();
  return b ? b.deadlineMs - Date.now() : Infinity;
}

const REPEAT_TIMEOUT_TERMINAL_LIVES = 2;

export function isJobTimeoutMessage(message: string | null | undefined): boolean {
  return /job timed out after|timed out|was aborted/i.test(message ?? '');
}

/**
 * A refresh that exhausted the job budget on consecutive lives is not going to
 * fit on the next one either (TikTok is stalling this source's proxy path).
 * Same shape as the insufficient_credits rule: stop after N lives, not
 * MAX_ATTEMPTS, instead of re-queuing every few minutes.
 */
export function repeatedTimeoutIsTerminal(
  job: { kind: string; attempts: number; lastError: string | null },
  message: string,
): boolean {
  return job.kind === 'refresh'
    && job.attempts >= REPEAT_TIMEOUT_TERMINAL_LIVES
    && isJobTimeoutMessage(message)
    && isJobTimeoutMessage(job.lastError);
}
