import { describe, expect, test } from 'bun:test';
import { keepAlive, runWithWaitUntil } from './wait-until.js';

describe('keepAlive', () => {
  test('is a no-op outside a request (Node/tests)', () => {
    expect(keepAlive(Promise.resolve())).toBe(false);
  });

  test('pins the promise to the request waitUntil', async () => {
    const pinned: Promise<unknown>[] = [];
    const result = await runWithWaitUntil(
      (p) => {
        pinned.push(p);
      },
      async () => {
        expect(keepAlive(Promise.resolve('x'))).toBe(true);
        return 7;
      },
    );
    expect(result).toBe(7);
    expect(pinned).toHaveLength(1);
    await pinned[0];
  });

  test('a rejected promise is still pinned and does not throw from waitUntil', async () => {
    const pinned: Promise<unknown>[] = [];
    await runWithWaitUntil(
      (p) => {
        pinned.push(p);
      },
      () => {
        expect(keepAlive(Promise.reject(new Error('nope')))).toBe(true);
      },
    );
    await expect(pinned[0]).resolves.toBeUndefined();
  });
});
