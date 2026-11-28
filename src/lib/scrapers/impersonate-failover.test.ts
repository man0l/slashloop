import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createImpersonatedHttp, resetImpersonatedClient } from './impersonate-http.js';
import { resetDispatcher } from './proxy-http.js';

// Fake Impit: the proxy URL's `_country-XX` password suffix tells us which
// exit a client was built for. Exits listed in `deadExits` refuse the tunnel.
const deadExits = new Set<string>();
const built: string[] = [];
const calls: Array<{ country: string; url: string; cookie?: string }> = [];

const refusal = () => new Error('Proxy rejected the CONNECT tunnel with status code 502.');

mock.module('impit', () => ({
  Impit: class {
    private readonly country: string;
    constructor(opts: { proxyUrl: string }) {
      this.country = /_country-([A-Za-z]+)/.exec(decodeURIComponent(opts.proxyUrl))?.[1] ?? '';
      built.push(this.country);
    }
    async fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response> {
      calls.push({ country: this.country, url, cookie: init?.headers?.Cookie });
      if (deadExits.has(this.country)) throw refusal();
      const headers = new Headers();
      if (url === 'https://www.tiktok.com/') headers.append('set-cookie', `ttwid=jar-${this.country}; Path=/`);
      return new Response(JSON.stringify({ ok: true, via: this.country }), { status: 200, headers });
    }
  },
}));

const ENV = ['SCRAPER_PROXY_URL', 'SCRAPER_PROXY_COUNTRY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SCRAPER_PROXY_URL = 'http://user:pass@proxy.test:8080';
  deadExits.clear();
  built.length = 0;
  calls.length = 0;
  resetDispatcher();
  resetImpersonatedClient();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDispatcher();
  resetImpersonatedClient();
});

const api = 'https://www.tiktok.com/api/creator/item_list/?secUid=x';

describe('impit exit-country failover (SLA-1756)', () => {
  test('starts on the primary country and stays there while it answers', async () => {
    process.env.SCRAPER_PROXY_COUNTRY = 'XX,US';
    const http = (await createImpersonatedHttp())!;
    const r = await http.getJson(api);
    expect((r.json as any).via).toBe('XX');
    expect(built).toEqual(['XX']);
  });

  test('a refused CONNECT mid-request fails over to the next country with its own warmed jar', async () => {
    process.env.SCRAPER_PROXY_COUNTRY = 'XX,US';
    const http = (await createImpersonatedHttp())!;
    deadExits.add('XX'); // pool dies after the warm-up succeeded
    const r = await http.getJson(api);
    expect((r.json as any).via).toBe('US');
    expect(built).toEqual(['XX', 'US']);
    // The US request carries the US jar (warmed on the new client), not XX's cookie.
    const usApi = calls.find(c => c.country === 'US' && c.url.includes('/api/'))!;
    expect(usApi.cookie).toContain('ttwid=jar-US');
    expect(usApi.cookie).not.toContain('jar-XX');
    // XX was not re-asked 3 times with backoff: one refused API attempt only.
    expect(calls.filter(c => c.country === 'XX' && c.url.includes('/api/')).length).toBe(1);
  });

  test('a dead exit is benched: the next client starts on the live country', async () => {
    process.env.SCRAPER_PROXY_COUNTRY = 'XX,US';
    deadExits.add('XX');
    const first = (await createImpersonatedHttp())!; // warm-up refused -> benched
    expect(((await first.getJson(api)).json as any).via).toBe('US');
    built.length = 0;
    calls.length = 0;
    const second = (await createImpersonatedHttp())!;
    expect(((await second.getJson(api)).json as any).via).toBe('US');
    expect(calls.some(c => c.country === 'XX')).toBe(false);
  });

  test('every country refusing surfaces the tunnel error, never an unlisted country', async () => {
    process.env.SCRAPER_PROXY_COUNTRY = 'XX,US';
    deadExits.add('XX');
    deadExits.add('US');
    const http = (await createImpersonatedHttp())!;
    await expect(http.getJson(api)).rejects.toThrow('CONNECT tunnel');
    expect(new Set(built)).toEqual(new Set(['XX', 'US']));
    expect(built.some(c => ['IN', 'CN', 'HK'].includes(c))).toBe(false);
  });

  test('a single configured country keeps the retry-in-place behaviour', async () => {
    process.env.SCRAPER_PROXY_COUNTRY = 'US';
    const http = (await createImpersonatedHttp())!;
    deadExits.add('US');
    await expect(http.getJson(api)).rejects.toThrow('CONNECT tunnel');
    expect(built).toEqual(['US']);
    expect(calls.filter(c => c.url.includes('/api/')).length).toBeGreaterThan(1);
  }, 15_000);
});
