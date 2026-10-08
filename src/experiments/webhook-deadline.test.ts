// SLA-624: the per-request deadline must hold against endpoints that never trip the socket idle timeout.
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { createGuardedGet, createGuardedPost, deliver, REQUEST_DEADLINE_MS, resolvePublic, type PostTransport } from './webhook-delivery.js';

const plainHttp = (): PostTransport => ({ request: http.request as unknown as PostTransport['request'], protocol: 'http:' });

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

const listen = async (server: net.Server): Promise<URL> => {
  const sockets = new Set<Socket>();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  closers.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
};

describe('guardedPost response snippet', () => {
  test('returns the status and at most the first 1 KB of the body', async () => {
    const url = await listen(http.createServer((_req, res) => { res.statusCode = 403; res.end('E'.repeat(5000)); }));
    const res = await createGuardedPost(2_000, plainHttp())(url, {}, '{}');
    expect(res.status).toBe(403);
    expect(res.body).toBe('E'.repeat(1024));
  });
});

describe('guardedGet', () => {
  test('sends a bodyless GET with its headers and keeps far more than 1 KB so a marker deep in a listing is found', async () => {
    let seen: { method?: string; auth?: string; length?: string } = {};
    const url = await listen(http.createServer((req, res) => {
      seen = { method: req.method, auth: req.headers.authorization, length: req.headers['content-length'] };
      res.end('x'.repeat(100_000) + '<!-- slashloop-experiment:e1:review:3 -->');
    }));
    const res = await createGuardedGet(2_000, plainHttp())(url, { authorization: 'Bearer k' });
    expect(seen).toEqual({ method: 'GET', auth: 'Bearer k', length: undefined });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<!-- slashloop-experiment:e1:review:3 -->');
  });
});

describe('guardedPost overall deadline', () => {
  test('the default deadline is 15s', () => expect(REQUEST_DEADLINE_MS).toBe(15_000));

  test('a body that trickles a byte every 20ms is cut off at the deadline', async () => {
    let open = 0;
    const url = await listen(net.createServer(sock => {
      open++;
      sock.on('error', () => {});
      const t = setInterval(() => sock.write('1\r\nx\r\n'), 20);
      sock.on('close', () => { open--; clearInterval(t); });
      sock.once('data', () => sock.write('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n'));
    }));
    const started = Date.now();
    await expect(createGuardedPost(300, plainHttp())(url, {}, '{}')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000);
    await Bun.sleep(200);
    expect(open).toBe(0);
  });

  test('a status line that trickles in byte by byte is cut off at the deadline', async () => {
    const url = await listen(net.createServer(sock => {
      sock.on('error', () => {});
      sock.once('data', () => {
        let i = 0;
        const line = 'HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello';
        const t = setInterval(() => { if (i < line.length) sock.write(line[i++]!); }, 100);
        sock.on('close', () => clearInterval(t));
      });
    }));
    const started = Date.now();
    await expect(createGuardedPost(400, plainHttp())(url, {}, '{}')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a prompt response resolves with its status and leaves no timer behind', async () => {
    const url = await listen(http.createServer((_req, res) => { res.writeHead(204); res.end(); }));
    const post = createGuardedPost(60_000, plainHttp());
    await expect(post(url, {}, '{}')).resolves.toMatchObject({ status: 204 });
    await expect(post(url, {}, '{}')).resolves.toMatchObject({ status: 204 });
  });

  test('a deadline hit is a retryable network error, not a permanent failure', async () => {
    const url = await listen(http.createServer((_req, res) => { res.writeHead(200); const t = setInterval(() => res.write('x'), 20); res.on('close', () => clearInterval(t)); }));
    const post = createGuardedPost(200, plainHttp());
    const row = { idempotencyKey: 'k', workspaceId: 'w', notifyJson: JSON.stringify({ url: 'https://hooks.example.com/x', secret: null }), payloadJson: '{}' };
    const res = await deliver(row, { post: () => post(url, {}, '{}') });
    expect(res).toMatchObject({ ok: false, permanent: false, status: null, error: 'network_error:DEADLINE_EXCEEDED' });
  });
});

describe('pinned address (works on Node and Bun, whose https shim ignores `lookup`)', () => {
  const answers = (list: Array<{ address: string; family: number }>) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: typeof list) => void) => cb(null, list)) as Parameters<typeof resolvePublic>[1];

  test('resolvePublic returns the first public address', async () => {
    await expect(resolvePublic('hooks.example.com', answers([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]))).resolves.toBe('93.184.216.34');
  });
  test('resolvePublic prefers IPv4 when an AAAA answer comes first, and falls back to IPv6 when it is the only family', async () => {
    await expect(resolvePublic('hooks.example.com', answers([{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }]))).resolves.toBe('93.184.216.34');
    await expect(resolvePublic('v6.example.com', answers([{ address: '2606:2800:220:1::1', family: 6 }]))).resolves.toBe('2606:2800:220:1::1');
  });
  test('a private AAAA answer still blocks the host even when a public IPv4 is preferred', async () => {
    await expect(resolvePublic('rebind6.example.com', answers([{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }]))).rejects.toMatchObject({ code: 'blocked_address' });
  });
  test('one private address among public ones blocks the host', async () => {
    await expect(resolvePublic('rebind.example.com', answers([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]))).rejects.toMatchObject({ code: 'blocked_address' });
  });
  test('literals: public passes through, private is blocked', async () => {
    await expect(resolvePublic('93.184.216.34')).resolves.toBe('93.184.216.34');
    await expect(resolvePublic('127.0.0.1')).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(resolvePublic('::1')).rejects.toMatchObject({ code: 'blocked_address' });
  });
  test('the request connects to the resolved IP and carries the hostname as Host', async () => {
    let host = '';
    const url = await listen(http.createServer((req, res) => { host = String(req.headers.host); res.writeHead(204); res.end(); }));
    const named = new URL(`http://hooks.example.test:${url.port}/hook`);
    const post = createGuardedPost(5_000, { ...plainHttp(), resolve: async h => (h === 'hooks.example.test' ? '127.0.0.1' : h) });
    await expect(post(named, {}, '{}')).resolves.toMatchObject({ status: 204 });
    expect(host).toBe(`hooks.example.test:${url.port}`);
  });
  test('a blocked resolution never opens a socket', async () => {
    let connections = 0;
    const url = await listen(net.createServer(s => { connections++; s.destroy(); }));
    const post = createGuardedPost(5_000, { ...plainHttp(), resolve: () => Promise.reject(Object.assign(new Error('blocked_address'), { code: 'blocked_address' })) });
    await expect(post(url, {}, '{}')).rejects.toMatchObject({ code: 'blocked_address' });
    expect(connections).toBe(0);
  });
  test('a resolver that never answers is cut off at the deadline', async () => {
    const url = await listen(http.createServer());
    const post = createGuardedPost(200, { ...plainHttp(), resolve: () => new Promise<string>(() => {}) });
    await expect(post(url, {}, '{}')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
});
