// ---------------------------------------------------------------------------
// Chrome-TLS HTTP over the residential proxy (yt-dlp's `impersonate=True`).
//
// Unsigned undici/Bun fetch has a Node JA3. TikTok answers /api/creator/item_list
// with 429 or an empty 200. Impit speaks Chrome's TLS + HTTP/2. Cookies from
// the first HTML hit (ttwid, msToken) go back out on the next API call. A WAF
// interstitial is solved in-process and retried once.
//
// Loaded dynamically so Vercel/tests that never scrape via proxy do not need
// the native binary.
// ---------------------------------------------------------------------------

import { meterBytes } from './bandwidth.js';
import { proxyConfig } from './proxy-http.js';
import { isWafChallenge, solveWafCookies, type WafCookie } from './waf.js';
import type { TikTokHttp, TikTokHttpResult } from './tiktok-web.js';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTML_MAX = 512 * 1024;
const JSON_MAX = 512 * 1024;

class CookieJar {
  private readonly map = new Map<string, string>();

  apply(cookies: WafCookie[]): void {
    for (const c of cookies) this.map.set(c.name, c.value);
  }

  absorb(headers: Headers): void {
    const getSet = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const raw = typeof getSet === 'function' ? getSet.call(headers) : [];
    const list = raw.length ? raw : [headers.get('set-cookie')].filter((x): x is string => !!x);
    for (const line of list) {
      const pair = line.split(';')[0];
      if (!pair) continue;
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.map.size === 0) return undefined;
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface ImpitLike {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export async function createImpersonatedHttp(): Promise<TikTokHttp | null> {
  const cfg = proxyConfig();
  if (!cfg) return null;

  let Impit: new (opts: Record<string, unknown>) => ImpitLike;
  try {
    ({ Impit } = await import('impit') as unknown as { Impit: new (opts: Record<string, unknown>) => ImpitLike });
  } catch (err) {
    console.warn(`[proxy:impit] not available: ${(err as Error).message}`);
    return null;
  }

  const client = new Impit({
    browser: 'chrome',
    proxyUrl: cfg.url,
    ignoreTlsErrors: true,
  });
  const jar = new CookieJar();
  console.log('[proxy:impit] chrome TLS via residential proxy');

  async function once(url: string, headers: Record<string, string> | undefined, maxBytes: number): Promise<TikTokHttpResult> {
    const hdrs: Record<string, string> = {
      'User-Agent': CHROME_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(headers ?? {}),
    };
    const cookie = jar.header();
    if (cookie) hdrs.Cookie = cookie;

    const res = await client.fetch(url, { headers: hdrs, redirect: 'follow' });
    jar.absorb(res.headers);
    const text = await res.text();
    const bytes = Math.min(text.length, maxBytes);
    meterBytes(bytes);
    let json: any | null = null;
    const slice = text.length > maxBytes ? text.slice(0, maxBytes) : text;
    if (res.ok && slice) {
      try { json = JSON.parse(slice); } catch { json = null; }
    }
    return { json, status: res.status, ok: res.ok, text: slice, bytes };
  }

  async function withWaf(url: string, headers: Record<string, string> | undefined, maxBytes: number): Promise<TikTokHttpResult> {
    const first = await once(url, headers, maxBytes);
    if (!first.text || !isWafChallenge(first.text)) return first;
    const cookies = solveWafCookies(first.text);
    if (!cookies.length) {
      console.warn('[proxy:impit] WAF page but puzzle unsolved');
      return first;
    }
    jar.apply(cookies);
    console.log(`[proxy:impit] solved WAF (${cookies.map(c => c.name).join(',')}), retrying`);
    return once(url, headers, maxBytes);
  }

  return {
    async getJson(url, headers) {
      return withWaf(url, { Accept: 'application/json, text/plain, */*', ...(headers ?? {}) }, JSON_MAX);
    },
    async getText(url, headers) {
      const r = await withWaf(url, { Accept: 'text/html,application/xhtml+xml', ...(headers ?? {}) }, HTML_MAX);
      return { ...r, json: null };
    },
  };
}
