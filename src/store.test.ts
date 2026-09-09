import { beforeEach, describe, expect, test } from 'bun:test';
import { DbBusyError, db, setActiveClient } from './store.js';

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
  setActiveClient(fakeClient([]));
});

describe('db turn (process-wide serialization)', () => {
  test('concurrent calls on different delegates do not overlap', async () => {
    const events: string[] = [];
    setActiveClient(fakeClient(events));
    await Promise.all([
      db.video.findMany({}),
      db.source.findMany({}),
      db.video.findFirst({}),
    ]);
    // Strictly sequential: every start follows the previous end.
    const order = events.map((e) => e.split(':')[1]);
    expect(order).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
  });

  test('a throw releases the turn for the next caller', async () => {
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

  test('$queryRaw tag calls go through the turn', async () => {
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
