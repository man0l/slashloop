#!/usr/bin/env node
// Node-only Playwright scrape. Bun on Windows cannot complete Playwright's
// WebSocket handshake, so the parent (often Bun) shells this file out.
// Logs go to stderr. The last stdout line is __SLASHLOOP_RESULT__{json}.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const WEB_BASE = 'https://www.tiktok.com';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ANALYTIC_HOSTS = [
  'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
  'googlesyndication.com', 'facebook.com', 'fbcdn.net', 'hotjar.com',
  'scorecardresearch.com', 'criteo.com', 'taboola.com', 'outbrain.com',
  'amplitude.com', 'mixpanel.com', 'segment.com', 'sentry.io', 'clarity.ms',
];
const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;
const RESULT = '__SLASHLOOP_RESULT__';

function log(...args) {
  console.error('[proxy:worker]', ...args);
}

function parseProxyUrl(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (!u.hostname) return null;
  let password = u.password ? decodeURIComponent(u.password) : undefined;
  // Proxy-Cheap encodes geo in the password (`_country-US`). A random
  // exit in IN/CN/HK serves TikTok's discontinued /in/about page.
  const country = (process.env.SCRAPER_PROXY_COUNTRY ?? 'US').trim();
  if (password && country && !/_country-/i.test(password)) {
    password = `${password}_country-${country}`;
  }
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 8080,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password,
  };
}

function sourceUrl(sourceType, query) {
  const q = query.replace(/^[@#]/, '').trim();
  if (sourceType === 'creator') return `${WEB_BASE}/@${encodeURIComponent(q)}`;
  if (sourceType === 'hashtag') return `${WEB_BASE}/tag/${encodeURIComponent(q)}`;
  return `${WEB_BASE}/search?q=${encodeURIComponent(q)}`;
}

function xhrPattern(sourceType) {
  if (sourceType === 'creator') return /\/api\/post\/item_list/;
  if (sourceType === 'hashtag') return /\/api\/challenge\/item_list/;
  return /\/api\/search\/(item|general)/;
}

function extractRehydrationJson(html) {
  const marker = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function itemsFromRehydration(html) {
  const data = extractRehydrationJson(html);
  if (!data) return [];
  const items = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const id = node.id != null ? String(node.id) : '';
    if (/^\d{6,}$/.test(id) && node.video && typeof node.video === 'object') {
      if (!seen.has(id)) { seen.add(id); items.push({ ...node, id }); }
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return items;
}

function itemsFromApiPayload(json) {
  if (!json || typeof json !== 'object') return [];
  const list = json.itemList ?? json.itemListByHashTagName ?? json.itemListBySearch
    ?? json.aweme_list ?? json.item_list ?? json.data ?? [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    const item = row?.item ?? row;
    if (!item || typeof item !== 'object') continue;
    const id = item.id != null ? String(item.id) : '';
    if (/^\d{6,}$/.test(id)) out.push({ ...item, id });
  }
  return out;
}

function dedupe(items) {
  const byId = new Map();
  for (const it of items) {
    const id = it?.id != null ? String(it.id) : '';
    if (id && !byId.has(id)) byId.set(id, it);
  }
  return [...byId.values()];
}

function findChrome() {
  // Only an explicit override. Auto-picking system Chrome pulls in user
  // policies/extensions; Playwright's Chromium is the one that hydrates.
  return process.env.SCRAPER_CHROME_PATH?.trim() || undefined;
}

function wantHeadless() {
  if (process.env.SCRAPER_PROXY_HEADLESS === '1') return true;
  if (process.env.SCRAPER_PROXY_HEADLESS === '0') return false;
  return process.platform !== 'win32';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function scrape(job) {
  const cfg = parseProxyUrl(process.env.SCRAPER_PROXY_URL);
  if (!cfg) throw new Error('SCRAPER_PROXY_URL is required');
  const headless = wantHeadless();
  const executablePath = findChrome();
  const proxyServer = `http://${cfg.host}:${cfg.port}`;
  let bytes = 0;
  const meter = (n) => { if (Number.isFinite(n) && n > 0) bytes += n; };

  log(`start headless=${headless} chrome=${executablePath ?? 'playwright'} via ${cfg.host}:${cfg.port}`);

  // Playwright's launch({ proxy }) fails CONNECT to tiktok.com
  // (net::ERR_TUNNEL_CONNECTION_FAILED). Chrome's own --proxy-server
  // plus context credentials works.
  const browser = await chromium.launch({
    headless,
    executablePath: executablePath || undefined,
    timeout: 45_000,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${proxyServer}`,
    ],
  });

  try {
    const context = await browser.newContext({
      proxy: { server: proxyServer, username: cfg.username, password: cfg.password },
      userAgent: CHROME_UA,
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
    });
    await context.addInitScript(STEALTH);
    const page = await context.newPage();
    const url = sourceUrl(job.sourceType, job.query);
    const pattern = xhrPattern(job.sourceType);
    const xhrItems = [];
    const blockMedia = process.env.SCRAPER_PROXY_BLOCK_MEDIA !== '0';
    await page.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const reqUrl = req.url();
      if (blockMedia && (type === 'image' || type === 'media')) return route.abort();
      if (ANALYTIC_HOSTS.some(h => reqUrl.includes(h))) return route.abort();
      if (pattern.test(reqUrl)) {
        const res = await route.fetch();
        const text = await res.text();
        meter(Buffer.byteLength(text ?? '', 'utf8'));
        log(`xhr ${res.status()} ${text.length}B type=${res.headers()['content-type'] ?? '-'} ${reqUrl.slice(0, 80)}`);
        try { xhrItems.push(...itemsFromApiPayload(JSON.parse(text))); } catch { /* not json */ }
        return route.fulfill({ response: res, body: text });
      }
      return route.continue();
    });

    browser.on('disconnected', () => log('browser disconnected'));
    page.on('crash', () => log('page crashed'));
    page.on('close', () => log('page closed'));
    page.on('response', (res) => {
      try {
        const len = Number(res.headers()['content-length']);
        if (Number.isFinite(len) && len > 0) meter(len);
      } catch { /* ignore */ }
    });

    log(`goto ${url}`);
    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const status = nav?.status() ?? 0;
    log(`goto done status=${status}`);

    for (const sel of ['button[data-e2e="banner-cookie"]', '#ttsconsent-button-submit', 'button:has-text("Accept all")', 'button:has-text("Decline all")']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1200 })) { await el.click({ timeout: 1200 }); break; }
      } catch { /* no banner */ }
    }
    if (job.sourceType === 'keyword') {
      try {
        const tab = page.locator('a:has-text("Videos")').first();
        if (await tab.isVisible({ timeout: 2500 })) await tab.click({ timeout: 2500 });
      } catch { /* no tab */ }
    }

    await page.waitForResponse((res) => pattern.test(res.url()), { timeout: 18_000 }).catch(() => {});
    await page.waitForFunction(
      'document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent?.length > 100',
      { timeout: 8_000 },
    ).catch(() => {});
    // Give webmssdk time to hook fetch, then scroll so a SIGNED item_list fires.
    await new Promise(r => setTimeout(r, 4000));

    // Read the blob from the live DOM (page.content() HTML-escapes it and
    // itemsFromRehydration then sees zero videos).
    let ssrItems = await page.evaluate(`(() => {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el || !el.textContent) return [];
      let data;
      try { data = JSON.parse(el.textContent); } catch (e) { return []; }
      const items = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const n of node) walk(n); return; }
        const id = node.id != null ? String(node.id) : (node.aweme_id != null ? String(node.aweme_id) : '');
        const video = node.video;
        if (/^\\d{6,}$/.test(id) && video && typeof video === 'object') {
          if (!seen.has(id)) { seen.add(id); items.push(Object.assign({}, node, { id: id })); }
          return;
        }
        for (const k of Object.keys(node)) walk(node[k]);
      };
      walk(data);
      return items;
    })()`).catch((err) => {
      log(`ssr evaluate failed: ${err.message}`);
      return [];
    });
    const diag = await page.evaluate(`(() => {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      return {
        title: document.title,
        href: location.href,
        hasUniversal: !!el,
        universalLen: el && el.textContent ? el.textContent.length : 0,
        bodyLen: document.body && document.body.innerText ? document.body.innerText.length : 0,
      };
    })()`).catch((err) => ({ title: '', hasUniversal: false, error: err.message }));
    log(`nav ${status} ssr=${ssrItems.length} xhr=${xhrItems.length} diag=${JSON.stringify(diag)}`);

    const need = Math.max(0, (job.limit ?? 30) - ssrItems.length);
    if (need > 0) {
      const deadline = Date.now() + 25_000;
      let last = 0, stable = 0;
      while (Date.now() < deadline && xhrItems.length < need) {
        await page.mouse.wheel(0, 1800);
        await new Promise(r => setTimeout(r, 1100));
        if (xhrItems.length === last) { if (++stable >= 4) break; }
        else stable = 0;
        last = xhrItems.length;
      }
    }
    if (ssrItems.length === 0) {
      // Scroll may have hydrated a late blob — try the live DOM once more.
      ssrItems = await page.evaluate(`(() => {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!el || !el.textContent) return [];
        let data;
        try { data = JSON.parse(el.textContent); } catch (e) { return []; }
        const items = [];
        const seen = new Set();
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const n of node) walk(n); return; }
          const id = node.id != null ? String(node.id) : '';
          if (/^\\d{6,}$/.test(id) && node.video && typeof node.video === 'object') {
            if (!seen.has(id)) { seen.add(id); items.push(Object.assign({}, node, { id: id })); }
            return;
          }
          for (const k of Object.keys(node)) walk(node[k]);
        };
        walk(data);
        return items;
      })()`).catch(() => []);
    }

    let items = dedupe([...ssrItems, ...xhrItems]);
    if (job.postedAfter) {
      const cutoff = Math.floor(new Date(job.postedAfter).getTime() / 1000);
      items = items.filter(it => {
        const t = Number(it?.createTime);
        return !Number.isFinite(t) || t >= cutoff;
      });
    }
    items = items.slice(0, job.limit ?? 30);
    const notices = [];
    if (items.length === 0) {
      notices.push(
        `TikTok ${job.sourceType} "${job.query}" returned no videos `
        + `(title=${diag?.title ?? ''} hydrated=${diag?.hasUniversal} xhrEmpty=true). `
        + 'This exit is bot-walled: profile SSR has no itemList and /api/post/item_list is a 0-byte JSON. '
        + 'Keep SCRAPER_PROVIDER=apify, or set SCRAPER_FALLBACK_PROVIDER=apify, or use a cleaner residential pool.',
      );
    }
    return { items, notices, bytesUsed: bytes, diag };
  } finally {
    await browser.close().catch(() => {});
  }
}

const raw = (await readStdin()).trim();
if (!raw) {
  console.log(RESULT + JSON.stringify({ items: [], notices: ['browser worker received no job'], bytesUsed: 0 }));
  process.exit(2);
}
try {
  const job = JSON.parse(raw);
  const result = await scrape(job);
  console.log(RESULT + JSON.stringify(result));
  process.exit(result.items.length > 0 ? 0 : 2);
} catch (err) {
  log(`failed: ${err?.stack ?? err}`);
  console.log(RESULT + JSON.stringify({
    items: [],
    notices: [String(err?.message ?? err)],
    bytesUsed: 0,
  }));
  process.exit(1);
}
