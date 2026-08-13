// ---------------------------------------------------------------------------
// Browser scrape session — the request-signing strategy proven by
// cognitive_grass/slashloop-tiktok-scraper (src/routes.ts).
//
// Unsigned Node fetch (aid=1988 + a Chrome UA) gets an empty body. In-page
// fetch() after hydrating the homepage also returns HTTP 200 / 0 bytes in
// headless. What actually works is letting TikTok's own web app sign:
//
//   1. Launch Chromium (headful on Windows) through the residential proxy
//   2. Abort images / media / fonts / CSS / analytics (the GB killers)
//   3. Navigate to /@handle, /tag/x, or /search?q=
//   4. Read the first page from __UNIVERSAL_DATA_FOR_REHYDRATION__ (SSR —
//      the first items are NOT an XHR)
//   5. Intercept TikTok's own signed XHR and scroll for more
//
// One browser process serves every source in this process.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meterBytes } from './bandwidth.js';
import { parseProxyUrl, withStickySession } from './proxy-http.js';
import {
  dedupeItems,
  itemsFromApiPayload,
  itemsFromRehydration,
  tiktokSourceUrl,
  xhrPatternFor,
  type SourceKind,
  type TikTokHttp,
  type TikTokHttpResult,
} from './tiktok-web.js';

const ANALYTIC_HOSTS = [
  'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
  'googlesyndication.com', 'facebook.com', 'fbcdn.net', 'hotjar.com',
  'scorecardresearch.com', 'criteo.com', 'taboola.com', 'outbrain.com',
  'amplitude.com', 'mixpanel.com', 'segment.com', 'sentry.io',
  'clarity.ms', 'tiktok.com/akamai',
];

// Match the fingerprint the working community signer uses (Safari / MacIntel).
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

function loadLocalSdk(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, 'vendor', 'webmssdk_5.1.3.js');
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

type PlaywrightPage = {
  route(pattern: string, handler: (route: any) => Promise<void> | void): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForFunction(fn: (() => boolean) | string, opts?: { timeout?: number }): Promise<unknown>;
  waitForResponse(fn: (res: any) => boolean, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: ((arg?: any) => T | Promise<T>) | string, arg?: any): Promise<T>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  locator(sel: string): { first(): { isVisible(opts?: { timeout?: number }): Promise<boolean>; click(opts?: { timeout?: number }): Promise<void> } };
  mouse: { wheel(x: number, y: number): Promise<void> };
  close(): Promise<void>;
};

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  addInitScript(fn: (() => void) | string): Promise<void>;
};

let page: PlaywrightPage | null = null;
let browser: { close(): Promise<void> } | null = null;
let chromeProc: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function runningBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function wantHeadless(): boolean {
  if (process.env.SCRAPER_PROXY_HEADLESS === '1') return true;
  if (process.env.SCRAPER_PROXY_HEADLESS === '0') return false;
  // HeadlessChrome is what TikTok fingerprints. Desktop Windows can run
  // headful; a Linux worker (xvfb or not) still has to try headless unless
  // the operator opts into a virtual display.
  return process.platform !== 'win32';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[proxy:signer] ${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

function findChrome(): string | undefined {
  const override = process.env.SCRAPER_CHROME_PATH?.trim();
  if (override) return override;
  const candidates = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(p => p && existsSync(p));
}

const STEALTH_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

async function launchViaCdp(
  chromium: any,
  executablePath: string,
  headless: boolean,
  cfg: { host: string; port: number; username?: string; password?: string },
  proxyServer: string,
): Promise<PlaywrightContext> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'slashloop-chrome-'));
  const port = 9222 + Math.floor(Math.random() * 800);
  console.log(`[proxy:signer] spawning chromium cdp=:${port} headless=${headless}`);
  const args = [
    headless ? '--headless=new' : '',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--proxy-server=${proxyServer}`,
    '--disable-gpu',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ].filter(Boolean);
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: headless,
  });
  chromeProc = child;
  await waitForCdp(port, 20_000);
  const launched = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser = launched;
  return launched.newContext({
    proxy: { server: proxyServer, username: cfg.username, password: cfg.password },
    userAgent: CHROME_UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
}

async function waitForCdp(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`[proxy:signer] CDP :${port} not ready (${last})`);
}

async function launch(): Promise<void> {
  if (page) return;
  if (starting) return starting;
  starting = (async () => {
    const cfg = parseProxyUrl(process.env.SCRAPER_PROXY_URL);
    if (!cfg) throw new Error('SCRAPER_PROXY_URL is required for the warm-signer');

    let chromium: any;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        'playwright is not installed. Run `bun add playwright` and `bunx playwright install chromium`.',
      );
    }

    const headless = wantHeadless();
    const proxyServer = `http://${cfg.host}:${cfg.port}`;
    process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = '0';
    const executablePath = findChrome() || chromium.executablePath();
    console.log(
      `[proxy:signer] start headless=${headless} bun=${runningBun()} chrome=${executablePath} via ${cfg.host}:${cfg.port}`,
    );

    try {
      let context: PlaywrightContext;
      if (runningBun()) {
        // Bun on Windows never completes Playwright's pipe/WebSocket handshake.
        context = await launchViaCdp(chromium, executablePath, headless, cfg, proxyServer);
      } else {
        const launched = await chromium.launch({
          headless,
          executablePath,
          timeout: 45_000,
          args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            `--proxy-server=${proxyServer}`,
          ],
        });
        browser = launched;
        context = await launched.newContext({
          proxy: { server: proxyServer, username: cfg.username, password: cfg.password },
          userAgent: CHROME_UA,
          locale: 'en-US',
          viewport: { width: 1280, height: 720 },
        });
      }
      await context.addInitScript(STEALTH_SCRIPT);
      await context.addInitScript(`Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });`);
      const sdk = loadLocalSdk();
      if (sdk) console.log(`[proxy:signer] local webmssdk ready (${sdk.length}B)`);
      const p = await context.newPage();
      await p.route('**/*', async (route: any) => {
        const req = route.request();
        const type = req.resourceType() as string;
        const url = req.url() as string;
        if (url.includes('/webmssdk/') && sdk) {
          return route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: sdk,
          });
        }
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        // Never abort acrawler / webmssdk — that is the signer.
        if (ANALYTIC_HOSTS.some(h => url.includes(h))) return route.abort();
        return route.continue();
      });
      page = p;
      await stabilizeSession(p);
      console.log('[proxy:signer] browser ready');
    } catch (err) {
      console.error(`[proxy:signer] launch failed: ${(err as Error).message}`);
      page = null;
      await closeWarmSigner().catch(() => {});
      throw err;
    }
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function stabilizeSession(p: PlaywrightPage): Promise<void> {
  // Same sequence the working signer uses: first load is often a white
  // page or "Something went wrong"; reload primes msToken and the SDK.
  console.log('[proxy:signer] priming session on a public profile');
  const primeItems: any[] = [];
  const onPrime = (res: any) => { void collectFromResponse(res, /\/api\/(post|recommend|challenge|search)\//, primeItems); };
  p.on('response', onPrime);
  await p.goto('https://www.tiktok.com/@tiktok', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await new Promise(r => setTimeout(r, 3000));
  try {
    await p.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch { /* reload can race */ }
  await new Promise(r => setTimeout(r, 4000));
  await dismissTikTokError(p);
  const sdk = await p.evaluate(`({
    acrawler: !!window.byted_acrawler,
    frontier: !!(window.byted_acrawler && window.byted_acrawler.frontierSign)
  })`).catch(() => ({ acrawler: false, frontier: false }));
  p.off('response', onPrime);
  console.log(`[proxy:signer] sdk ${JSON.stringify(sdk)} primeXhrItems=${primeItems.length}`);
}

async function dismissTikTokError(p: PlaywrightPage): Promise<void> {
  try {
    const has = await p.evaluate(` /Something went wrong/i.test(document.body ? document.body.innerText : '') `);
    if (!has) return;
    console.log('[proxy:signer] dismissing "Something went wrong"');
    await p.evaluate(`{
      const btn = Array.from(document.querySelectorAll('button')).find(b => /^\\s*Refresh\\s*$/i.test(b.textContent || ''));
      if (btn) btn.click();
    }`);
    await new Promise(r => setTimeout(r, 2500));
  } catch { /* ignore */ }
}

async function dismissConsent(p: PlaywrightPage): Promise<void> {
  const selectors = [
    'button[data-e2e="banner-cookie"]',
    '#ttsconsent-button-submit',
    'button:has-text("Accept all")',
    'button:has-text("Decline all")',
  ];
  for (const sel of selectors) {
    try {
      const el = p.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 })) {
        await el.click({ timeout: 1200 });
        return;
      }
    } catch {
      // banner not present
    }
  }
}

async function pageDiag(p: PlaywrightPage): Promise<Record<string, unknown>> {
  return p.evaluate(`(() => {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    let scopeKeys = [];
    if (el && el.textContent) {
      try {
        const d = JSON.parse(el.textContent);
        scopeKeys = d.__DEFAULT_SCOPE__ ? Object.keys(d.__DEFAULT_SCOPE__) : [];
      } catch (e) {}
    }
    return {
      title: document.title,
      href: location.href,
      hasUniversal: !!el,
      universalLen: el && el.textContent ? el.textContent.length : 0,
      scopeKeys: scopeKeys,
      bodyLen: (document.body && document.body.innerText ? document.body.innerText : '').length
    };
  })()`);
}

function meterResponse(res: any): void {
  try {
    const headers = typeof res.headers === 'function' ? res.headers() : {};
    const len = Number(headers['content-length']);
    if (Number.isFinite(len) && len > 0) meterBytes(len);
  } catch { /* ignore */ }
}

async function collectFromResponse(res: any, pattern: RegExp, sink: any[]): Promise<void> {
  if (!pattern.test(res.url())) return;
  const text = await res.text().catch(() => '');
  meterBytes(Buffer.byteLength(text ?? '', 'utf8'));
  console.log(`[proxy:signer] xhr ${res.status()} ${text.length}B ${String(res.url()).slice(0, 96)}`);
  try {
    const json = JSON.parse(text);
    sink.push(...itemsFromApiPayload(json));
  } catch {
    // HTML / captcha / empty
  }
}

async function scrollToLoad(
  p: PlaywrightPage,
  xhrItems: any[],
  alreadyHave: number,
  limit: number,
  maxDurationMs = 25_000,
): Promise<void> {
  const need = Math.max(0, limit - alreadyHave);
  if (need === 0) return;
  const deadline = Date.now() + maxDurationMs;
  let lastCount = 0;
  let stableTicks = 0;
  while (Date.now() < deadline && xhrItems.length < need) {
    await p.mouse.wheel(0, 1800);
    await new Promise(r => setTimeout(r, 1100));
    if (xhrItems.length === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 4) break;
    } else {
      stableTicks = 0;
    }
    lastCount = xhrItems.length;
  }
}

function applyLimit(items: any[], opts: { limit: number; postedAfter?: Date }): any[] {
  let out = items;
  if (opts.postedAfter) {
    const cutoff = Math.floor(opts.postedAfter.getTime() / 1000);
    out = out.filter(it => {
      const t = Number(it?.createTime);
      return !Number.isFinite(t) || t >= cutoff;
    });
  }
  return out.slice(0, opts.limit);
}

async function pageEvaluateFetch(
  p: PlaywrightPage,
  url: string,
): Promise<{ status?: number; len?: number; text?: string; error?: string }> {
  return p.evaluate(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await r.text();
      return { status: r.status, len: text.length, text: text };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  })()`);
}

async function signedProxyGet(p: PlaywrightPage, rawUrl: string): Promise<{ status: number; text: string }> {
  const signed = await p.evaluate(`(() => {
    const raw = ${JSON.stringify(rawUrl)};
    const u = new URL(raw);
    u.searchParams.delete('X-Bogus');
    u.searchParams.delete('X-Gnarly');
    u.searchParams.delete('_signature');
    const qs = u.search.slice(1);
    const crawler = window.byted_acrawler;
    if (!crawler || typeof crawler.frontierSign !== 'function') {
      return { error: 'frontierSign missing', url: u.toString() };
    }
    let stamp = crawler.frontierSign(qs);
    if (typeof stamp === 'string') stamp = { 'X-Bogus': stamp };
    if (stamp && stamp['X-Bogus']) u.searchParams.set('X-Bogus', stamp['X-Bogus']);
    if (stamp && stamp['X-Gnarly']) u.searchParams.set('X-Gnarly', stamp['X-Gnarly']);
    if (stamp && stamp._signature) u.searchParams.set('_signature', stamp._signature);
    const ms = (document.cookie.match(/msToken=([^;]+)/) || [])[1];
    if (ms) u.searchParams.set('msToken', ms);
    return { url: u.toString(), stamp: stamp, cookies: document.cookie };
  })()`) as { error?: string; url?: string; cookies?: string; stamp?: unknown };

  if (signed.error || !signed.url) {
    console.log(`[proxy:signer] frontierSign failed: ${signed.error ?? 'no url'}`);
    return { status: 0, text: '' };
  }
  console.log(`[proxy:signer] frontierSign ok bogus=${!!(signed.stamp as any)?.['X-Bogus']}`);
  // Fetch INSIDE Chrome. Node/undici of a signed URL is dropped at TikTok's
  // edge (200 / 0 bytes) — same finding as the 2025 webmssdk writeups.
  const res = await pageEvaluateFetch(p, signed.url);
  return { status: res.status ?? 0, text: res.text ?? '' };
}

async function signedApiFetch(
  p: PlaywrightPage,
  opts: { sourceType: SourceKind; query: string; limit: number },
): Promise<any[]> {
  const q = opts.query.replace(/^[@#]/, '').trim();
  let url = '';
  if (opts.sourceType === 'creator') {
    // Never reuse the primed page's secUid — that belongs to @tiktok.
    const detail = await signedProxyGet(p, `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(q)}&aid=1988&app_name=tiktok_web&device_platform=web_pc`);
    console.log(`[proxy:signer] user/detail ${detail.status} ${detail.text.length}B ${detail.text.slice(0, 180)}`);
    const parsed = (() => { try { return JSON.parse(detail.text); } catch { return null; } })();
    const got = parsed?.userInfo?.user?.secUid;
    if (typeof got !== 'string' || !got) return itemsFromApiPayload(parsed);
    url = `https://www.tiktok.com/api/post/item_list/?aid=1988&app_name=tiktok_web&device_platform=web_pc&secUid=${encodeURIComponent(got)}&cursor=0&count=${opts.limit}&browser_platform=MacIntel&os=mac`;
  } else if (opts.sourceType === 'hashtag') {
    url = `https://www.tiktok.com/api/challenge/item_list/?aid=1988&app_name=tiktok_web&challengeName=${encodeURIComponent(q)}&cursor=0&count=${opts.limit}`;
  } else {
    url = `https://www.tiktok.com/api/search/item/full/?aid=1988&keyword=${encodeURIComponent(q)}&offset=0&count=${opts.limit}`;
  }

  const out = await signedProxyGet(p, url);

  console.log(`[proxy:signer] item api ${out.status} ${out.text.length}B ${out.text.slice(0, 180)}`);
  if (!out.text) return [];
  try {
    return itemsFromApiPayload(JSON.parse(out.text));
  } catch {
    return [];
  }
}

async function scrapeOnce(opts: {
  sourceType: SourceKind;
  query: string;
  limit: number;
  postedAfter?: Date;
}): Promise<{ items: any[]; notices: string[] }> {
  await launch();
  const p = page!;
  const notices: string[] = [];

  // Stay on the primed page. Navigating to the target often yields a blank
  // document and kills the SDK session. Signed fetch from the warm page is
  // what the working community signer uses as /fetch.
  console.log(`[proxy:signer] signed fetch first for ${opts.sourceType}=${opts.query}`);
  let items = await signedApiFetch(p, opts);
  if (items.length > 0) {
    items = applyLimit(dedupeItems(items), opts);
    return { items, notices };
  }
  // Do not navigate away from the primed page — that blanks the document
  // and the next XHR is 200/0B. Stay here and fail honestly if signing
  // did not produce items.
  notices.push(`Signed fetch returned no videos for ${opts.sourceType} "${opts.query}"`);
  return { items: [], notices };

  const url = tiktokSourceUrl(opts.sourceType, opts.query);
  const pattern = xhrPatternFor(opts.sourceType);
  const xhrItems: any[] = [];

  const onResponse = (res: any) => {
    meterResponse(res);
    void collectFromResponse(res, pattern, xhrItems);
  };
  p.on('response', onResponse);

  try {
    console.log(`[proxy:signer] goto ${url} (fallback)`);
    const nav = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = (nav as { status?: () => number } | null)?.status?.() ?? 0;
    await dismissConsent(p);

    if (opts.sourceType === 'keyword') {
      try {
        const tab = p.locator('a:has-text("Videos")').first();
        if (await tab.isVisible({ timeout: 2500 })) await tab.click({ timeout: 2500 });
      } catch { /* tab missing */ }
    }

    await p.waitForResponse((res: any) => pattern.test(res.url()), { timeout: 18_000 }).catch(() => {});
    try {
      await p.waitForFunction(
        'document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent?.length > 100',
        { timeout: 8_000 },
      );
    } catch { /* SSR may never arrive on a wall */ }

    const html = await p.evaluate('document.documentElement ? document.documentElement.outerHTML : ""') as string;
    meterBytes(Buffer.byteLength(html, 'utf8'));
    let ssrItems = itemsFromRehydration(html);
    const diag = await pageDiag(p).catch(() => ({}));
    console.log(`[proxy:signer] nav ${status} ssr=${ssrItems.length} xhr=${xhrItems.length} diag=${JSON.stringify(diag)}`);

    await scrollToLoad(p, xhrItems, ssrItems.length, opts.limit);
    if (ssrItems.length === 0) {
      const later = await p.evaluate('document.documentElement ? document.documentElement.outerHTML : ""') as string;
      ssrItems = itemsFromRehydration(later);
    }

    if (ssrItems.length + xhrItems.length === 0) {
      const signed = await signedApiFetch(p, opts);
      if (signed.length) {
        console.log(`[proxy:signer] signed fetch recovered ${signed.length} items`);
        xhrItems.push(...signed);
      }
    }

    items = applyLimit(dedupeItems([...ssrItems, ...xhrItems]), opts);

    if (items.length === 0) {
      notices.push(
        `TikTok ${opts.sourceType} "${opts.query}" returned no videos`
        + `${diag && 'title' in diag ? ` (title=${(diag as { title?: unknown }).title} hydrated=${(diag as { hasUniversal?: unknown }).hasUniversal})` : ''}`,
      );
    }
    return { items, notices };
  } finally {
    p.off('response', onResponse);
  }
}

const RESULT_PREFIX = '__SLASHLOOP_RESULT__';

function scrapeViaNodeWorker(opts: {
  sourceType: SourceKind;
  query: string;
  limit: number;
  postedAfter?: Date;
}): Promise<{ items: any[]; notices: string[] }> {
  const worker = fileURLToPath(new URL('./browser-worker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    console.log(`[proxy:signer] bun cannot drive Playwright on this host — spawning node worker`);
    const child = spawn('node', [worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: false,
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); });
    child.on('error', reject);
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, 110_000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const line = stdout.split(/\r?\n/).find(l => l.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error(`[proxy:signer] node worker exited ${code} with no result`));
        return;
      }
      try {
        const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as {
          items?: any[];
          notices?: string[];
          bytesUsed?: number;
        };
        if (typeof parsed.bytesUsed === 'number') meterBytes(parsed.bytesUsed);
        resolve({ items: parsed.items ?? [], notices: parsed.notices ?? [] });
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.write(JSON.stringify({
      sourceType: opts.sourceType,
      query: opts.query,
      limit: opts.limit,
      postedAfter: opts.postedAfter ? opts.postedAfter.toISOString() : undefined,
    }));
    child.stdin.end();
  });
}

export async function scrapeTikTokInBrowser(opts: {
  sourceType: SourceKind;
  query: string;
  limit: number;
  postedAfter?: Date;
}): Promise<{ items: any[]; notices: string[] }> {
  // Playwright's WebSocket handshake does not complete under Bun on Windows.
  // The scrape itself runs in a stock Node process (same as the Apify actor).
  if (runningBun()) {
    return serialized(() => withTimeout(
      scrapeViaNodeWorker(opts),
      120_000,
      `node-worker ${opts.sourceType}=${opts.query}`,
    ));
  }
  return serialized(() => withTimeout(
    scrapeOnce(opts),
    90_000,
    `scrape ${opts.sourceType}=${opts.query}`,
  ));
}

// Kept for callers that still want a signed GET (download fallback, tests).
async function inPageNavigate(url: string): Promise<TikTokHttpResult> {
  await launch();
  const res = await page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }) as { status?: () => number } | null;
  const text = await page!.evaluate('document.documentElement ? document.documentElement.outerHTML : ""') as string;
  const status = typeof res?.status === 'function' ? res.status() : 0;
  const bytes = Buffer.byteLength(text ?? '', 'utf8');
  meterBytes(bytes);
  return { json: null, status, ok: status >= 200 && status < 400, text, bytes };
}

async function inPageGet(url: string, headers: Record<string, string> | undefined): Promise<TikTokHttpResult> {
  await launch();
  const result = await withTimeout(
    page!.evaluate(async ({ url, headers }) => {
      const res = await fetch(url, { credentials: 'include', headers: headers ?? {} });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    }, { url, headers: headers ?? {} }),
    20_000,
    `in-page fetch ${url.slice(0, 64)}`,
  );
  let json: any = null;
  if (result.text) {
    try { json = JSON.parse(result.text); } catch { json = null; }
  }
  const bytes = Buffer.byteLength(result.text ?? '', 'utf8');
  meterBytes(bytes);
  return { json, status: result.status, ok: result.ok, text: result.text, bytes };
}

export const warmHttp: TikTokHttp = {
  getJson: (url, headers) => serialized(() => inPageGet(url, headers)),
  getText: (url) => serialized(() => inPageNavigate(url)),
};

export async function closeWarmSigner(): Promise<void> {
  const p = page;
  const b = browser;
  const child = chromeProc;
  page = null;
  browser = null;
  chromeProc = null;
  try { await p?.close(); } catch { /* already gone */ }
  try { await b?.close(); } catch { /* already gone */ }
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { /* already gone */ }
  }
}
