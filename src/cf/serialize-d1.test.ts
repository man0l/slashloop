import { describe, expect, test } from 'bun:test';
import { d1BindParam } from '../store.js';
import { serializeD1 } from './serialize-d1.js';

describe('d1BindParam', () => {
  test('Dates become ISO strings D1 will accept', () => {
    const d = new Date('2026-09-01T13:50:04.000Z');
    expect(d1BindParam(d)).toBe('2026-09-01T13:50:04.000+00:00');
  });

  test('booleans become 0/1', () => {
    expect(d1BindParam(true)).toBe(1);
    expect(d1BindParam(false)).toBe(0);
  });

  test('strings and numbers pass through', () => {
    expect(d1BindParam('abc')).toBe('abc');
    expect(d1BindParam(3)).toBe(3);
    expect(d1BindParam(null)).toBe(null);
  });
});

function mockD1(opts?: { hang?: boolean }) {
  let inflight = 0;
  let maxInflight = 0;
  const started: string[] = [];

  const run = async (label: string) => {
    started.push(label);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    if (opts?.hang) await new Promise(() => { /* never settles */ });
    await new Promise((r) => setTimeout(r, 20));
    inflight--;
    return { results: [{ label }], success: true };
  };

  const makeStmt = (sql: string): D1PreparedStatement => {
    const stmt = {
      bind() {
        return stmt;
      },
      first: () => run(sql).then((r) => r.results?.[0] ?? null),
      run: () => run(sql),
      all: () => run(sql),
      raw: () => run(sql).then((r) => [r.results ?? []]),
    };
    return stmt as unknown as D1PreparedStatement;
  };

  const d1 = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return Promise.all(statements.map((s) => s.run()));
    },
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => ({ prepare: (sql: string) => makeStmt(sql), run: async () => [] }),
  } as unknown as D1Database;

  return { d1, get maxInflight() { return maxInflight; }, started };
}

describe('serializeD1', () => {
  test('runs concurrent statements one at a time', async () => {
    const mock = mockD1();
    const d1 = serializeD1(mock.d1);
    await Promise.all([
      d1.prepare('a').all(),
      d1.prepare('b').bind(1).all(),
      d1.prepare('c').run(),
      d1.prepare('d').first(),
    ]);
    expect(mock.maxInflight).toBe(1);
  });

  test('times out a hung query and fails later ones fast', async () => {
    const mock = mockD1({ hang: true });
    const d1 = serializeD1(mock.d1, { timeoutMs: 30 });
    await expect(d1.prepare('hang').all()).rejects.toThrow(/timed out after 30ms/);
    const t0 = Date.now();
    await expect(d1.prepare('next').all()).rejects.toThrow(/wedged on this isolate/);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('batch unwraps wrapped statements so the real binding sees them', async () => {
    const seen: D1PreparedStatement[] = [];
    const innerStmt: D1PreparedStatement = {
      bind() { return innerStmt; },
      first: async () => null,
      run: async () => ({ results: [], success: true }),
      all: async () => ({ results: [], success: true }),
      raw: async () => [],
    };
    const d1 = serializeD1({
      prepare: () => innerStmt,
      batch: async (statements: D1PreparedStatement[]) => {
        seen.push(...statements);
        return statements.map(() => ({ results: [], success: true }));
      },
      exec: async () => ({}),
      withSession: () => ({ prepare: () => innerStmt, run: async () => [] }),
    } as unknown as D1Database);
    const a = d1.prepare('a').bind(1);
    const b = d1.prepare('b');
    await d1.batch([a, b]);
    expect(seen).toEqual([innerStmt, innerStmt]);
  });
});
