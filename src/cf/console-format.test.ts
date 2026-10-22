import { describe, expect, test } from 'bun:test';
import { installConsoleSpecExpansion } from './console-format.js';

function fakeConsole() {
  const calls: Record<string, unknown[][]> = { log: [], info: [], warn: [], error: [], debug: [] };
  const c = {} as Record<string, unknown>;
  for (const k of Object.keys(calls)) c[k] = (...args: unknown[]) => { calls[k].push(args); };
  return { c: c as unknown as Console, calls };
}

describe('installConsoleSpecExpansion', () => {
  test("console.error('Error in performIO: %O', err) ships the expanded error, not %O", () => {
    const { c, calls } = fakeConsole();
    installConsoleSpecExpansion(c);
    const err = new Error('internal error; reference = e_abc123');
    err.name = 'DriverAdapterError';
    err.cause = { kind: 'sqlite', extendedCode: 1, message: 'internal error' };

    c.error('Error in performIO: %O', err);

    expect(calls.error).toHaveLength(1);
    expect(calls.error[0]).toHaveLength(1);
    const line = calls.error[0][0] as string;
    expect(line).not.toMatch(/%[sdifjoOc]/);
    expect(line).toContain('Error in performIO: DriverAdapterError');
    expect(line).toContain('e_abc123');
    expect(line).toContain('sqlite');
  });

  test('expands %s and %d across warn/log too', () => {
    const { c, calls } = fakeConsole();
    installConsoleSpecExpansion(c);
    c.warn('retry %s after %d ms', 'rescore', 250);
    c.log('x %d', 7);
    expect(calls.warn[0]).toEqual(['retry rescore after 250 ms']);
    expect(calls.log[0]).toEqual(['x 7']);
  });

  test('calls without specs pass through with original args (objects stay structured)', () => {
    const { c, calls } = fakeConsole();
    installConsoleSpecExpansion(c);
    const obj = { a: 1 };
    c.error('[worker] cron failed', obj);
    c.error('plain');
    c.error('100%', 5);
    expect(calls.error[0]).toEqual(['[worker] cron failed', obj]);
    expect(calls.error[1]).toEqual(['plain']);
    expect(calls.error[2]).toEqual(['100%', 5]);
  });

  test('is idempotent: installing twice does not double-wrap', () => {
    const { c, calls } = fakeConsole();
    installConsoleSpecExpansion(c);
    installConsoleSpecExpansion(c);
    c.error('a %s', 'b');
    expect(calls.error).toEqual([['a b']]);
  });
});
