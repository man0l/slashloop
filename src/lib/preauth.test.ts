import { expect, test } from 'bun:test';
import { runPreauthed, type PreauthDeps } from './preauth.js';
import { runWithWaitUntil } from '../cf/wait-until.js';
import type { CreditBalance } from './credits.js';

const balance = (total: number): CreditBalance => ({ planCredits: 0, packCredits: total, total });

function deps(log: string[]): PreauthDeps & { refunds: Array<'call_failed' | 'fetch_failed'> } {
  const refunds: Array<'call_failed' | 'fetch_failed'> = [];
  return {
    refunds,
    debitCredits: async () => {
      log.push('debit');
      return balance(288);
    },
    refundCredits: async (_w, _c, _t, _ref, reason = 'call_failed') => {
      if (reason !== 'call_failed' && reason !== 'fetch_failed') throw new Error(reason);
      log.push(`refund:${reason}`);
      refunds.push(reason);
      return balance(290);
    },
    creditBalance: async () => balance(288),
    keepAlive: () => false,
  };
}

test('a thrown model call refunds the preauth', async () => {
  const log: string[] = [];
  const d = deps(log);
  const result = await runPreauthed({
    workspaceId: 'w',
    credits: 2,
    tool: 'create_brief',
    run: async () => { throw new Error('gemini down'); },
  }, d);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.aborted).toBe(false);
    expect(result.creditsCharged).toBe(0);
    expect(result.balance.total).toBe(290);
  }
  expect(d.refunds).toEqual(['call_failed']);
});

test('an aborted call refunds and does not keep the debit when the model call later returns', async () => {
  const d = deps([]);
  const signal = new AbortController();
  const result = await runPreauthed({
    workspaceId: 'w',
    credits: 2,
    tool: 'create_brief',
    signal: signal.signal,
    run: async () => {
      signal.abort('mcp_remote_fetch_failed');
      return { id: 'brief-orphaned' };
    },
  }, d);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.aborted).toBe(true);
  expect(result.creditsCharged).toBe(0);
  expect(d.refunds).toEqual(['fetch_failed']);
});

test('a finished call keeps the debit', async () => {
  const d = deps([]);
  const result = await runPreauthed({
    workspaceId: 'w',
    credits: 2,
    tool: 'create_brief',
    run: async () => ({ id: 'brief-1' }),
  }, d);
  expect(result).toMatchObject({ ok: true, creditsCharged: 2, value: { id: 'brief-1' } });
  expect(d.refunds).toEqual([]);
});

test('the abort refund is pinned with waitUntil so a client disconnect cannot cancel it', async () => {
  const pinned: Promise<unknown>[] = [];
  const signal = new AbortController();
  const d = deps([]);
  d.keepAlive = (promise) => {
    pinned.push(promise);
    return true;
  };
  const result = await runWithWaitUntil((p) => { pinned.push(p); }, () => runPreauthed({
    workspaceId: 'w',
    credits: 2,
    tool: 'create_brief',
    signal: signal.signal,
    run: async () => {
      signal.abort();
      return 'finished-after-disconnect';
    },
  }, d));
  expect(result.ok).toBe(false);
  expect(d.refunds).toEqual(['fetch_failed']);
  expect(pinned.length).toBeGreaterThan(0);
  await Promise.all(pinned);
});
