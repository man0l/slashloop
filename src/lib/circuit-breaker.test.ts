// Unit tests for the D1 circuit breaker (src/lib/circuit-breaker.ts). Pure.
import { describe, expect, test } from 'bun:test';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

const timeoutErr = () => new Error('D1 batch[1] timed out after 15000ms: SELECT 1');
const infraErr = () => new Error('D1_ERROR: internal error; reference = abc');
const appErr = () => new Error('statements must number 1..50');

describe('CircuitBreaker', () => {
  test('passes through until threshold, then opens and recovers', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ name: 'test', threshold: 3, cooldownMs: 60_000, now: () => t });
    expect(await cb.execute(async () => 'ok')).toBe('ok');
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    // Third failure opens; next call fails fast without touching the op.
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    let touched = false;
    await expect(cb.execute(async () => { touched = true; return 'x'; }))
      .rejects.toBeInstanceOf(CircuitOpenError);
    expect(touched).toBe(false);
    // Cool-down elapses: single probe passes and closes the circuit.
    t += 60_000;
    expect(await cb.execute(async () => 'probe')).toBe('probe');
    expect(await cb.execute(async () => 'back')).toBe('back');
    expect(cb.isOpen).toBe(false);
  });

  test('failed probe re-opens for another cool-down', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ name: 'test', threshold: 2, cooldownMs: 60_000, now: () => t });
    await expect(cb.execute(async () => { throw infraErr(); })).rejects.toThrow('D1_ERROR');
    await expect(cb.execute(async () => { throw infraErr(); })).rejects.toThrow('D1_ERROR');
    t += 60_000;
    await expect(cb.execute(async () => { throw infraErr(); })).rejects.toThrow('D1_ERROR');
    expect(cb.isOpen).toBe(true);
  });

  test('application errors never count, successes reset the streak', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ name: 'test', threshold: 2, cooldownMs: 60_000, now: () => t });
    await expect(cb.execute(async () => { throw appErr(); })).rejects.toThrow('must number');
    await expect(cb.execute(async () => { throw appErr(); })).rejects.toThrow('must number');
    expect(cb.isOpen).toBe(false);
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    expect(await cb.execute(async () => 'ok')).toBe('ok');
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    expect(cb.isOpen).toBe(false);
  });

  test('concurrent callers fail fast while the probe is in flight', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ name: 'test', threshold: 1, cooldownMs: 60_000, now: () => t });
    await expect(cb.execute(async () => { throw timeoutErr(); })).rejects.toThrow('timed out');
    t += 60_000;
    let release!: () => void;
    const probe = cb.execute(() => new Promise<string>((r) => { release = () => r('slow'); }));
    await expect(cb.execute(async () => 'other')).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    expect(await probe).toBe('slow');
    expect(cb.isOpen).toBe(false);
  });

  test('5xx and network failures count as infra on the default classifier', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ name: 'test', threshold: 2, cooldownMs: 10_000, now: () => t });
    await expect(cb.execute(async () => { throw new Error('D1 batch via worker failed: HTTP 503'); }))
      .rejects.toThrow('503');
    await expect(cb.execute(async () => { throw new Error('fetch failed'); })).rejects.toThrow('fetch failed');
    expect(cb.isOpen).toBe(true);
  });
});
