import { beforeEach, describe, expect, test } from 'bun:test';
import { DbBusyError, db, resetDbTurnForTests, setActiveClient } from './store.js';

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
