import { describe, expect, test } from 'bun:test';

import { isTransientD1Error, retryTransientD1 } from './retry-d1.js';

// A shallow look-alike of the real `DriverAdapterError` (name + cause.kind).
function d1Error(kind?: string, message = 'internal error'): Error {
  const e = new Error(message);
  e.name = 'DriverAdapterError';
  (e as { cause: unknown }).cause = { kind, extendedCode: 1, message };
  return e;
}

describe('isTransientD1Error', () => {
  test('a generic/internal DriverAdapterError is transient', () => {
    expect(isTransientD1Error(d1Error(undefined, 'internal error'))).toBe(true);
    expect(isTransientD1Error(d1Error('sqlite'))).toBe(true);
  });

  test('a permanent schema/constraint kind is NOT transient', () => {
    expect(isTransientD1Error(d1Error('TableDoesNotExist'))).toBe(false);
    expect(isTransientD1Error(d1Error('ColumnNotFound'))).toBe(false);
    expect(isTransientD1Error(d1Error('NullConstraintViolation'))).toBe(false);
    expect(isTransientD1Error(d1Error('ForeignKeyConstraintViolation'))).toBe(false);
  });

  test('network/HTTP failure codes are transient', () => {
    expect(isTransientD1Error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientD1Error(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientD1Error({ name: 'OtherError', cause: { status: 500 } })).toBe(true);
    expect(isTransientD1Error({ name: 'OtherError', cause: { status: 429 } })).toBe(true);
  });

  test('a plain / 4xx failure is not transient', () => {
    expect(isTransientD1Error(new Error('nope'))).toBe(false);
    expect(isTransientD1Error({ name: 'OtherError', cause: { status: 400 } })).toBe(false);
    expect(isTransientD1Error(null)).toBe(false);
    expect(isTransientD1Error('a string')).toBe(false);
  });
});

describe('retryTransientD1', () => {
  test('returns on first success without retrying', async () => {
    let calls = 0;
    const out = await retryTransientD1(async () => { calls++; return 'ok'; });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries a transient error, then succeeds', async () => {
    let calls = 0;
    const out = await retryTransientD1(async () => {
      calls++;
      if (calls < 3) throw d1Error(undefined, 'internal error');
      return 'recovered';
    }, { baseMs: 1, maxMs: 2, jitter: 0 });
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  test('does NOT retry a permanent error', async () => {
    let calls = 0;
    await expect(retryTransientD1(async () => {
      calls++;
      throw d1Error('TableDoesNotExist');
    })).rejects.toMatchObject({ name: 'DriverAdapterError' });
    expect(calls).toBe(1);
  });

  test('gives up after the final attempt, rethrowing the last error', async () => {
    let calls = 0;
    await expect(retryTransientD1(async () => {
      calls++;
      throw d1Error(undefined, 'still down');
    }, { attempts: 3, baseMs: 1, maxMs: 2, jitter: 0 })).rejects.toMatchObject({
      name: 'DriverAdapterError',
      message: 'still down',
    });
    expect(calls).toBe(3);
  });

  test('calls onRetry for each transient retry, not the final throw', async () => {
    const retried: number[] = [];
    let calls = 0;
    await expect(retryTransientD1(async () => {
      calls++;
      throw d1Error(undefined, 'down');
    }, { attempts: 3, baseMs: 1, maxMs: 2, jitter: 0, onRetry: (a) => retried.push(a) })).rejects.toBeDefined();
    expect(retried).toEqual([1, 2]);
    expect(calls).toBe(3);
  });

  test('passes the 1-based attempt number to fn', async () => {
    const seen: number[] = [];
    await retryTransientD1(async (n) => { seen.push(n); return n; }, { attempts: 3, baseMs: 1 });
    expect(seen).toEqual([1]);
  });
});
