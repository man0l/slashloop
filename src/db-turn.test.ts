// Unit tests for the process-wide DB turn (src/store.ts withDbTurn).
// No DB, no Workers runtime: the turn is pure promise mechanics.
//
// The load-bearing property: at most ONE fn runs at a time, even when
// waiters time out. The old promise-chain design released the turn on
// timeout, letting the next waiter barge in ahead of the still-running
// holder — overlapping Prisma engine use that wedged isolates live.
import { describe, expect, test } from 'bun:test';
import { DbBusyError, withDbTurn } from './store.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('withDbTurn', () => {
  test('runs calls serially in FIFO order', async () => {
    const order: string[] = [];
    const mk = (name: string, ms: number) => () =>
      (async () => {
        order.push(`start-${name}`);
        await sleep(ms);
        order.push(`end-${name}`);
        return name;
      })();
    const [a, b, c] = await Promise.all([
      withDbTurn(mk('a', 20)),
      withDbTurn(mk('b', 10)),
      withDbTurn(mk('c', 5)),
    ]);
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
  });

  test('never overlaps, even when a waiter times out behind a slow holder', async () => {
    let running = 0;
    let maxRunning = 0;
    const slow = () =>
      (async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(120);
        running--;
        return 'slow';
      })();
    const fast = () =>
      (async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(5);
        running--;
        return 'fast';
      })();
    // B arrives while A holds; B's 30ms timeout fires; C arrives after B
    // deserted and must still wait for A — never overlap it.
    const a = withDbTurn(slow, { timeoutMs: 5000 });
    await sleep(10);
    const b = withDbTurn(fast, { timeoutMs: 30 });
    await expect(b).rejects.toBeInstanceOf(DbBusyError);
    const c = withDbTurn(fast, { timeoutMs: 5000 });
    await expect(a).resolves.toBe('slow');
    await expect(c).resolves.toBe('fast');
    expect(maxRunning).toBe(1);
  });

  test('a timed-out waiter does not block the chain behind it', async () => {
    const holder = withDbTurn(() => sleep(80).then(() => 'h'), { timeoutMs: 5000 });
    await sleep(5);
    // B will time out and desert; C queued behind B must still run.
    const deserter = withDbTurn(() => sleep(1).then(() => 'nope'), { timeoutMs: 20 });
    const next = withDbTurn(() => sleep(1).then(() => 'yes'), { timeoutMs: 5000 });
    await expect(deserter).rejects.toBeInstanceOf(DbBusyError);
    await expect(holder).resolves.toBe('h');
    await expect(next).resolves.toBe('yes');
  });

  test('fn errors propagate and release the turn', async () => {
    const boom = withDbTurn(() => Promise.reject(new Error('kaboom')), { timeoutMs: 5000 });
    await expect(boom).rejects.toThrow('kaboom');
    await expect(withDbTurn(() => Promise.resolve('after'), { timeoutMs: 5000 })).resolves.toBe('after');
  });

  test('slow holders are logged with wait + hold durations', async () => {
    const logs: string[] = [];
    await withDbTurn(() => sleep(60).then(() => 'x'), {
      timeoutMs: 5000,
      slowMs: 30,
      onSlow: (m) => logs.push(m),
    });
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/\[db-turn-slow\] holder ran \d+ms \(waited \d+ms\): /);
  });

  test('fast holders stay silent', async () => {
    const logs: string[] = [];
    await withDbTurn(() => sleep(1).then(() => 'x'), {
      timeoutMs: 5000,
      slowMs: 1000,
      onSlow: (m) => logs.push(m),
    });
    expect(logs).toEqual([]);
  });
});
