import { describe, expect, test } from 'bun:test';
import { createLogShipper, formatMessage } from './ship-logs.js';

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  return (async (url: unknown, init?: unknown) =>
    impl(url as string, (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

describe('formatMessage', () => {
  test('joins args and truncates long lines', () => {
    expect(formatMessage(['hello', 42])).toBe('hello 42');
    expect(formatMessage([new Error('boom')])).toBe('Error: boom');
    expect(formatMessage(['x'.repeat(5000)]).length).toBeLessThanOrEqual(2001);
  });

  test('unstringifiable args do not throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatMessage([circular])).not.toThrow();
  });

  // SLA-386: the Prisma D1 adapter logs `console.error("Error in performIO:
  // %O", err)`. The old formatter joined args verbatim, shipping the LITERAL
  // `%O` and dropping the driver's detail object entirely.
  test('expands a printf %O spec so the object is rendered, not a literal %O', () => {
    const cause = { kind: 'sqlite', extendedCode: 1, message: 'internal error' };
    const err = new Error('internal error; reference = e_PVSMDp_9815dd15af20413aa71d75290955446f');
    err.name = 'DriverAdapterError';
    err.cause = cause;

    const line = formatMessage(['Error in performIO: %O', err]);
    expect(line).not.toContain('%O');
    // the reference id survives (it was only inside the dropped object before)
    expect(line).toContain('e_PVSMDp_9815dd15af20413aa71d75290955446f');
    // the driver cause object is rendered, not dropped
    expect(line).toContain('sqlite');
    // stays one line for the shipper
    expect(line).not.toContain('\n');
  });

  test('renders a bare Error arg as name: message + cause + reference', () => {
    const cause = { kind: 'sqlite', extendedCode: 5, message: 'locked' };
    const err = new Error('database is locked');
    err.name = 'DriverAdapterError';
    err.cause = cause;

    const line = formatMessage([err]);
    expect(line).toContain('DriverAdapterError: database is locked');
    expect(line).toContain('locked');
    expect(line).not.toContain('%O');
  });

  test('percent with no specifier does not treat a following arg as a spec', () => {
    // "50% done" has no %<directive>, so the trailing arg is just appended.
    expect(formatMessage(['50% done', 5])).toBe('50% done 5');
  });

  // Regression for the tail-loop hang: a `%%` (or a string with fewer
  // specifiers than extra args) left `argIndex` unincremented in the tail
  // loop, which appended the same arg forever and OOM'd the process.
  test('a %% does not consume an arg, and the tail never loops', () => {
    expect(formatMessage(['[x] 100%% sure', 'y'])).toBe('[x] 100% sure y');
    expect(formatMessage(['[x] done 100%% (%d)', 5])).toBe('[x] done 100% (5)');
    expect(formatMessage(['[x] %s', 'a', 'b'])).toBe('[x] a b');
  });
});

describe('createLogShipper', () => {
  test('one POST per line with service/message keys', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'svc',
      host: 'h',
      fetchImpl: stubFetch(async (_url, init) => {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response('{}', { status: 200 });
      }),
    });
    shipper.push('log', 'hello');
    shipper.push('warn', 'slow');
    shipper.push('error', 'boom');
    await shipper.flush();
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ service: 'svc', host: 'h', level: 'info', message: 'hello' });
    expect(posts[1]).toMatchObject({ level: 'warn', message: 'slow' });
    expect(posts[2]).toMatchObject({ level: 'error', message: 'boom' });
    for (const p of posts) expect(typeof p.ts).toBe('string');
    expect(shipper.size()).toBe(0);
  });

  test('flush caps entries per tick, remainder waits', async () => {
    let calls = 0;
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'svc',
      fetchImpl: stubFetch(async () => {
        calls++;
        return new Response('{}');
      }),
    });
    for (let i = 0; i < 100; i++) shipper.push('log', `l${i}`);
    await shipper.flush();
    expect(calls).toBe(30);
    expect(shipper.size()).toBe(70);
    await shipper.flush();
    expect(calls).toBe(60);
  });

  test('buffer is bounded — oldest dropped', () => {
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'svc',
      fetchImpl: stubFetch(async () => new Response('{}')),
    });
    for (let i = 0; i < 1000; i++) shipper.push('log', `l${i}`);
    expect(shipper.size()).toBeLessThanOrEqual(400);
  });

  test('a dead endpoint never throws and never blocks', async () => {
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'svc',
      fetchImpl: stubFetch(async () => {
        throw new Error('connection refused');
      }),
    });
    shipper.push('log', 'hello');
    await expect(shipper.flush()).resolves.toBeUndefined();
    shipper.push('log', 'again');
    await expect(shipper.flush()).resolves.toBeUndefined();
  });

  test('concurrent flush calls do not double-send', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'svc',
      fetchImpl: stubFetch(async () => {
        calls++;
        await gate;
        return new Response('{}');
      }),
    });
    shipper.push('log', 'a');
    const p1 = shipper.flush();
    const p2 = shipper.flush();
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
