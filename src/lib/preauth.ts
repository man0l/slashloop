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
  | {
      ok: false;
      aborted: boolean;
      error: unknown;
      balance: CreditBalance;
      creditsCharged: 0;
      /** Set when `run` finished and the client had already disconnected. */
      value?: T;
    };

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
    /**
     * Stable ledger identity. The same key replays the debit instead of
     * charging again. Omit it for a one-shot random id.
     */
    idempotencyKey?: string;
    run: () => Promise<T>;
  },
  deps: PreauthDeps = defaultDeps,
): Promise<PreauthResult<T>> {
  const opId = opts.idempotencyKey ?? randomUUID();
  const debited = await deps.debitCredits(opts.workspaceId, opts.credits, opts.tool, `${opId}:preauth`);
  // A replayed debit already moved the wallet on an earlier attempt. This
  // attempt must not install its own abort-refund, or a retry of a finished
  // call would give the charge back.
  const replayed = debited.replayed === true;

  const signal = opts.signal;
  let committed = false;
  let refundPromise: Promise<CreditBalance> | null = null;

  const closeWithRefund = (reason: 'call_failed' | 'fetch_failed'): Promise<CreditBalance> => {
    if (committed || replayed) return deps.creditBalance(opts.workspaceId);
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
    if (!replayed && (signal?.aborted || refundPromise)) {
      const balance = await closeWithRefund('fetch_failed');
      // The artifact may already exist. Hand it back so the tool can put the
      // id in the body instead of answering with an empty failure.
      return { ok: false, aborted: true, error: signal?.reason, balance, creditsCharged: 0, value };
    }
    committed = true;
    const balance = await deps.creditBalance(opts.workspaceId);
    return { ok: true, value, balance, creditsCharged: replayed ? 0 : opts.credits };
  } catch (error) {
    // A replayed debit that fails still refunds once. `:fail` is idempotent,
    // so an earlier refund of the same key does not grant the credits twice.
    // The replayed guard above skips that refund only after commit; a thrown
    // run has not committed, including when this attempt is the one that
    // finally notices the original call died before writing an artifact.
    if (replayed) {
      const balance = await deps.refundCredits(opts.workspaceId, opts.credits, opts.tool, `${opId}:fail`, 'call_failed').catch(() => deps.creditBalance(opts.workspaceId));
      return { ok: false, aborted: false, error, balance, creditsCharged: 0 };
    }
    const balance = await closeWithRefund('call_failed');
    return { ok: false, aborted: false, error, balance, creditsCharged: 0 };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
