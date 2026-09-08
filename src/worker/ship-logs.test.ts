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
