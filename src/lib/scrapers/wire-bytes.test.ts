import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, test } from 'bun:test';
import { REQUEST_OVERHEAD_BYTES, wireBytes } from './impersonate-http.js';
import { logProxyReconcile, resetProxyReconcile } from './reconcile.js';
import { PROFILE_ESTIMATE_BYTES } from '../../worker/tools-profile.js';
import { PROFILE_LITE_ESTIMATE_BYTES } from '../../worker/tools-jobs.js';
import { trafficCapBytes } from './bandwidth.js';

const html = (n: number) => '<html>' + '{"stats":{"diggCount":12345,"playCount":987654}},'.repeat(n) + '</html>';

describe('wireBytes', () => {
  test('compressed with content-length meters the exact wire size', () => {
    const decoded = html(8000);
    const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '41000' });
    expect(wireBytes(headers, decoded, decoded.length)).toBe(41_000 + REQUEST_OVERHEAD_BYTES);
    expect(decoded.length).toBeGreaterThan(41_000 * 4);
  });

  test('compressed and chunked (no content-length) meters gzip(decoded)', () => {
    const decoded = html(9000);
    const headers = new Headers({ 'content-encoding': 'br', 'transfer-encoding': 'chunked' });
    const expected = gzipSync(Buffer.from(decoded)).length;
    expect(wireBytes(headers, decoded, decoded.length)).toBe(expected + REQUEST_OVERHEAD_BYTES);
    expect(expected).toBeLessThan(decoded.length / 4);
  });

  test('chunked buffer bodies are gzipped from bytes', () => {
    const buf = Buffer.from(html(500));
    const headers = new Headers({ 'content-encoding': 'gzip' });
    expect(wireBytes(headers, buf, buf.length)).toBe(gzipSync(buf).length + REQUEST_OVERHEAD_BYTES);
  });

  test('uncompressed responses meter the decoded bytes', () => {
    expect(wireBytes(new Headers(), 'abc', 3)).toBe(3 + REQUEST_OVERHEAD_BYTES);
    const identity = new Headers({ 'content-encoding': 'identity', 'content-length': '3' });
    expect(wireBytes(identity, 'abc', 3)).toBe(3 + REQUEST_OVERHEAD_BYTES);
  });

  test('a bogus content-length falls back to gzip, never to zero', () => {
    const decoded = html(100);
    const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '0' });
    expect(wireBytes(headers, decoded, decoded.length)).toBe(gzipSync(Buffer.from(decoded)).length + REQUEST_OVERHEAD_BYTES);
  });

  test('overhead is a fixed 3 KB per request', () => {
    expect(REQUEST_OVERHEAD_BYTES).toBe(3 * 1024);
  });
});

describe('rescaled caps (wire bytes, capacity unchanged)', () => {
  test('profile pre-auth estimates are 1/4 of the decoded-byte ones', () => {
    expect(PROFILE_ESTIMATE_BYTES).toBe(0.6 * 1024 * 1024);
    expect(PROFILE_LITE_ESTIMATE_BYTES).toBe(0.4 * 1024 * 1024);
  });

  test('global monthly rail defaults to 0.25 GB', () => {
    const saved = process.env.PROXY_TRAFFIC_CAP_GB;
    delete process.env.PROXY_TRAFFIC_CAP_GB;
    try {
      expect(trafficCapBytes()).toBe(0.25 * 1024 ** 3);
    } finally {
      if (saved !== undefined) process.env.PROXY_TRAFFIC_CAP_GB = saved;
    }
  });
});

describe('logProxyReconcile', () => {
  beforeEach(() => resetProxyReconcile());
  const vendor = async () => ({ proxyId: 7, totalGb: 5, usedGb: 1.23, remainingGb: 3.77, status: 'ACTIVE', networkType: 'RESIDENTIAL' });

  test('logs ledger total next to Proxy-Cheap used GB, once per day', async () => {
    const lines: string[] = [];
    const deps = { ledger: async () => 300 * 1024 * 1024, vendor };
    const now = new Date('2026-10-29T10:00:00Z');
    const line = await logProxyReconcile(now, (l) => lines.push(l), deps);
    expect(line).toContain('[proxy:reconcile]');
    expect(line).toContain('300.00MB');
    expect(line).toContain('1.23GB');
    expect(await logProxyReconcile(new Date(now.getTime() + 3600_000), (l) => lines.push(l), deps)).toBeNull();
    expect(await logProxyReconcile(new Date(now.getTime() + 25 * 3600_000), (l) => lines.push(l), deps)).not.toBeNull();
    expect(lines).toHaveLength(2);
  });

  test('a vendor failure warns, logs nothing, and retries within the hour-ish', async () => {
    const lines: string[] = [];
    const now = new Date('2026-10-29T10:00:00Z');
    const failing = { ledger: async () => 0, vendor: async () => { throw new Error('boom'); } };
    expect(await logProxyReconcile(now, (l) => lines.push(l), failing)).toBeNull();
    expect(lines).toHaveLength(0);
    const ok = { ledger: async () => 0, vendor };
    expect(await logProxyReconcile(new Date(now.getTime() + 30 * 60_000), (l) => lines.push(l), ok)).toBeNull();
    expect(await logProxyReconcile(new Date(now.getTime() + 61 * 60_000), (l) => lines.push(l), ok)).not.toBeNull();
  });
});
