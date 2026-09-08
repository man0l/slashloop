import { describe, expect, test } from 'bun:test';
import { createLogShipper, formatLine } from './ship-logs.js';

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  return (async (url: unknown, init?: unknown) =>
    impl(url as string, (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

describe('formatLine', () => {
  test('plain log lines pass through, levels are tagged', () => {
    expect(formatLine('log', ['hello', 42])).toBe('hello 42');
    expect(formatLine('warn', ['slow'])).toBe('[warn] slow');
    expect(formatLine('error', [new Error('boom')])).toBe('[error] Error: boom');
  });

  test('long lines are truncated', () => {
    expect(formatLine('log', ['x'.repeat(2000)]).length).toBeLessThanOrEqual(501);
  });

  test('unstringifiable args do not throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLine('log', [circular])).not.toThrow();
  });
});

describe('createLogShipper', () => {
  test('flush posts lines and stays under the byte cap', async () => {
    const posts: Array<{ body: string }> = [];
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'test',
      host: 'h',
      fetchImpl: stubFetch(async (_url, init) => {
        posts.push({ body: String(init.body) });
        return new Response('{}', { status: 200 });
      }),
    });
    for (let i = 0; i < 100; i++) shipper.push(`line ${i} ` + 'y'.repeat(400));
    await shipper.flush();
    expect(posts.length).toBe(1);
    expect(Buffer.byteLength(posts[0]!.body)).toBeLessThanOrEqual(7 * 1024);
    expect(shipper.size()).toBeGreaterThan(0); // overflow waits for next tick
  });

  test('buffer is bounded — oldest dropped', () => {
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'test',
      fetchImpl: stubFetch(async () => new Response('{}')),
    });
    for (let i = 0; i < 1000; i++) shipper.push(`l${i}`);
    expect(shipper.size()).toBeLessThanOrEqual(400);
  });

  test('a dead endpoint never throws and never blocks', async () => {
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'test',
      fetchImpl: stubFetch(async () => {
        throw new Error('connection refused');
      }),
    });
    shipper.push('hello');
    await expect(shipper.flush()).resolves.toBeUndefined();
    // Failed batch is dropped; the shipper keeps working afterwards.
    shipper.push('again');
    await expect(shipper.flush()).resolves.toBeUndefined();
  });

  test('concurrent flush calls do not double-send', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const shipper = createLogShipper({
      url: 'https://example.test/log/t',
      service: 'test',
      fetchImpl: stubFetch(async () => {
        calls++;
        await gate;
        return new Response('{}');
      }),
    });
    shipper.push('a');
    const p1 = shipper.flush();
    const p2 = shipper.flush();
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
