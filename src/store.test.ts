import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DbBusyError, d1HttpRawExecutor, db, isUniqueViolation, resetDbTurnForTests, setActiveClient } from './store.js';

/** Fake Prisma-ish client: delegates with async methods + a $queryRaw tag. */
function fakeClient(events: string[], hangOn?: string) {
  const op = (name: string, ms = 5) => async (...args: unknown[]) => {
    events.push(`${name}:start`);
    if (hangOn === name) await new Promise(() => { /* never settles */ });
    await new Promise((r) => setTimeout(r, ms));
    events.push(`${name}:end`);
    return { name, args: args.length };
  };
  return {
    video: { findMany: op('video.findMany'), findFirst: op('video.findFirst') },
    source: { findMany: op('source.findMany') },
    $queryRaw: op('$queryRaw'),
  } as unknown as Parameters<typeof setActiveClient>[0];
}

beforeEach(() => {
  resetDbTurnForTests();
  setActiveClient(fakeClient([]));
});

describe('db proxy', () => {
  test('concurrent calls on different delegates overlap', async () => {
    const events: string[] = [];
    const pause = () => new Promise((r) => setTimeout(r, 20));
    setActiveClient({
      video: {
        findMany: async () => {
          events.push('video.findMany:start');
          await pause();
          events.push('video.findMany:end');
          return [];
        },
        findFirst: async () => {
          events.push('video.findFirst:start');
          await pause();
          events.push('video.findFirst:end');
          return null;
        },
      },
      source: {
        findMany: async () => {
          events.push('source.findMany:start');
          await pause();
          events.push('source.findMany:end');
          return [];
        },
      },
    } as unknown as Parameters<typeof setActiveClient>[0]);
    await Promise.all([
      db.video.findMany({}),
      db.source.findMany({}),
      db.video.findFirst({}),
    ]);
    expect(events.filter((e) => e.endsWith(':start'))).toHaveLength(3);
    expect(events.slice(0, 3).every((e) => e.endsWith(':start'))).toBe(true);
  });

  test('a throw does not break later calls', async () => {
    const events: string[] = [];
    setActiveClient(fakeClient(events));
    await expect(
      db.video.findMany({}).then(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await db.source.findMany({});
    expect(events).toContain('source.findMany:end');
  });

  test('tagged $queryRaw reaches the client', async () => {
    const events: string[] = [];
    setActiveClient(fakeClient(events));
    await (db.$queryRaw`SELECT 1` as unknown as Promise<unknown>);
    expect(events).toEqual(['$queryRaw:start', '$queryRaw:end']);
  });
});

describe('DbBusyError', () => {
  test('is an Error with a stable name for the router to map to 503', () => {
    const err = new DbBusyError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DbBusyError');
  });
});

describe('d1HttpRawExecutor worker batch path', () => {
  const realFetch = globalThis.fetch;
  const env = { url: process.env.WORKER_INTERNAL_URL, secret: process.env.CRON_SECRET };
  let calls = 0;

  function stubFetch(...replies: Array<{ status: number; body: unknown }>) {
    calls = 0;
    globalThis.fetch = (async () => {
      const r = replies[Math.min(calls++, replies.length - 1)]!;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
  }
  const run = () => d1HttpRawExecutor({ accountId: 'a', databaseId: 'd', token: 't' })([{ sql: 'SELECT 1' }]);

  beforeEach(() => {
    process.env.WORKER_INTERNAL_URL = 'https://worker.invalid';
    process.env.CRON_SECRET = 'test-secret';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (env.url === undefined) delete process.env.WORKER_INTERNAL_URL; else process.env.WORKER_INTERNAL_URL = env.url;
    if (env.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env.secret;
  });

  test('a 500 surfaces the Worker error body in the thrown message', async () => {
    stubFetch({ status: 500, body: { success: false, error: 'D1_ERROR: D1 DB is overloaded' } });
    await expect(run()).rejects.toThrow('D1 batch via worker failed: HTTP 500: D1_ERROR: D1 DB is overloaded');
    expect(calls).toBe(2);
  });

  test('a transient 500 is retried once and the retry result is returned', async () => {
    stubFetch(
      { status: 500, body: { success: false, error: 'D1_ERROR: Network connection lost' } },
      { status: 200, body: { success: true, results: [[{ a: 1 }]] } },
    );
    await expect(run()).resolves.toEqual([[{ a: 1 }]]);
    expect(calls).toBe(2);
  });

  test('a deterministic D1 error is not retried', async () => {
    stubFetch({ status: 500, body: { success: false, error: 'D1_ERROR: no such table: Nope' } });
    await expect(run()).rejects.toThrow('HTTP 500: D1_ERROR: no such table: Nope');
    expect(calls).toBe(1);
  });

  test('a 409 credit replay keeps its conflict text, is not retried, and does not trip the breaker', async () => {
    const conflict = 'D1_ERROR: UNIQUE constraint failed: CreditLedger.workspaceId, CreditLedger.refId';
    stubFetch({ status: 409, body: { success: false, error: conflict } });
    const exec = d1HttpRawExecutor({ accountId: 'a', databaseId: 'd', token: 't' });
    for (let i = 0; i < 4; i++) {
      const err = await exec([{ sql: 'x' }]).catch((e: Error) => e);
      expect((err as Error).message).toContain(conflict);
      expect(isUniqueViolation(err)).toBe(true);
    }
    expect(calls).toBe(4);
  });

  test('a non-JSON body is truncated to 500 characters', async () => {
    stubFetch({ status: 502, body: `<html>${'x'.repeat(2000)}</html>` });
    const err = await run().catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(600);
    expect((err as Error).message).toContain('HTTP 502: <html>');
    expect(calls).toBe(1);
  });
});
