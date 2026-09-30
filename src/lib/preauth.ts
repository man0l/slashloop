// Fixed-price MCP preauth that refunds when the call does not finish.
//
// debitCredits commits before the model call. The old tool handlers refund
// only from a catch around that call. Two failures never enter the catch:
//   • notifications/cancelled and transport close abort extra.signal, and the
//     SDK then drops the tool result (protocol.js) without running user catch
//     if the await is still pending.
//   • workerd cancels the request's promises when the client disconnects and
//     does not reject them (see src/cf/wait-until.ts). The catch never runs.
//     The debit is already committed, so the wallet moves with no UsageLog row.
//
// Listening on the abort signal and pinning the refund with keepAlive
// (ctx.waitUntil) is what still runs after that disconnect.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  creditBalance,
  debitCredits,
  refundCredits,
  type CreditBalance,
} from './credits.js';
import { keepAlive } from '../cf/wait-until.js';

const requestSignal = new AsyncLocalStorage<AbortSignal>();

/** Bind the inbound HTTP request's abort signal for the metered tool handlers. */
export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  return requestSignal.run(signal, fn);
}

export function currentRequestSignal(): AbortSignal | undefined {
  return requestSignal.getStore();
}

export function mergedAbortSignal(extra?: { signal?: AbortSignal }): AbortSignal | undefined {
  const signals = [currentRequestSignal(), extra?.signal].filter((s): s is AbortSignal => !!s);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export interface PreauthDeps {
  debitCredits: typeof debitCredits;
  refundCredits: typeof refundCredits;
  creditBalance: typeof creditBalance;
  keepAlive: typeof keepAlive;
}

const defaultDeps: PreauthDeps = { debitCredits, refundCredits, creditBalance, keepAlive };

export type PreauthResult<T> =
  | { ok: true; value: T; balance: CreditBalance; creditsCharged: number }
  | { ok: false; aborted: boolean; error: unknown; balance: CreditBalance; creditsCharged: 0 };

/**
 * Debit `credits`, run `run`, refund the same amount on throw or abort.
 * A successful return keeps the debit (it is the final charge, not an estimate).
 * InsufficientCreditsError propagates so the tool can return its usual payload.
 */
export async function runPreauthed<T>(
  opts: {
    workspaceId: string;
    credits: number;
    tool: string;
    signal?: AbortSignal;
    run: () => Promise<T>;
  },
  deps: PreauthDeps = defaultDeps,
): Promise<PreauthResult<T>> {
  const opId = randomUUID();
  await deps.debitCredits(opts.workspaceId, opts.credits, opts.tool, `${opId}:preauth`);

  const signal = opts.signal;
  let committed = false;
  let refundPromise: Promise<CreditBalance> | null = null;

  const closeWithRefund = (reason: 'call_failed' | 'fetch_failed'): Promise<CreditBalance> => {
    if (committed) return deps.creditBalance(opts.workspaceId);
    if (!refundPromise) {
      refundPromise = deps.refundCredits(opts.workspaceId, opts.credits, opts.tool, `${opId}:fail`, reason);
      deps.keepAlive(refundPromise);
    }
    return refundPromise;
  };

  const onAbort = () => {
    void closeWithRefund('fetch_failed');
  };

  if (signal) {
    if (signal.aborted) {
      const balance = await closeWithRefund('fetch_failed');
      return { ok: false, aborted: true, error: signal.reason, balance, creditsCharged: 0 };
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const value = await opts.run();
    if (signal?.aborted || refundPromise) {
      const balance = await closeWithRefund('fetch_failed');
      return { ok: false, aborted: true, error: signal?.reason, balance, creditsCharged: 0 };
    }
    committed = true;
    const balance = await deps.creditBalance(opts.workspaceId);
    return { ok: true, value, balance, creditsCharged: opts.credits };
  } catch (error) {
    const balance = await closeWithRefund('call_failed');
    return { ok: false, aborted: false, error, balance, creditsCharged: 0 };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
