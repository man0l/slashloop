// ---------------------------------------------------------------------------
// TikTok web client — the low-traffic scrape path.
//
// Everything below is shaped by one constraint: the residential proxy bills
// GIGABYTES. So we never render a page when an endpoint will answer, never ask
// for a second page when the first one already satisfied the request, and
// never move a single image or MP4 over the proxy.
//
// Where the bytes actually go, measured per source refresh:
//
//   profile HTML (full render)        ~1.4MB   avoided
//   profile HTML (early-abort read)   ~90KB    paid once per handle, then cached
//   item_list JSON page of 30         ~180KB   the real cost
//   cover images x30                  ~900KB   avoided entirely (never fetched)
//
// The single largest saving is refusing to download covers. The Apify path
// asks the actor to copy covers into its key-value store because Apify's
// egress is free to us; here every one of those images would be billed twice
// over (once to fetch, once as part of the plan's GB). So `coverDownloadUrl`
// is left null and the platform CDN URL is persisted instead — media ingest
// fetches it DIRECT, off-proxy, and only for videos that are actually shown.
//
// The second largest is the secUid cache: a creator's secUid never changes,
// but it only exists in the profile page's rehydration blob. Resolving it once
// per handle per day turns a ~90KB tax on every refresh into a rounding error.
// ---------------------------------------------------------------------------

import { proxyFetch, proxyFetchJson } from './proxy-http.js';
import { normalizeTikTok, type NormalizedVideo } from '../../normalizers.js';

export interface TikTokHttpResult {
  json: any | null;
  status: number;
  ok: boolean;
  text: string;
  bytes: number;
}

/** Pluggable transport so the adapter can swap unsigned HTTP for a signed in-page fetch. */
export interface TikTokHttp {
  getJson(url: string, headers?: Record<string, string>): Promise<TikTokHttpResult>;
  getText?(url: string, headers?: Record<string, string>): Promise<TikTokHttpResult>;
}

export const unsignedHttp: TikTokHttp = {
  async getJson(url, headers) {
    const { json, result } = await proxyFetchJson(url, { headers, maxBytes: JSON_MAX_BYTES });
    return { json, status: result.status, ok: result.ok, text: result.text, bytes: result.bytes };
  },
  async getText(url, headers) {
    const result = await proxyFetch(url, {
      headers,
      maxBytes: PROFILE_HTML_MAX_BYTES,
      stopWhen: pageBlobComplete,
    });
    return { json: null, status: result.status, ok: result.ok, text: result.text, bytes: result.bytes };
  },
};

let currentHttp: TikTokHttp = unsignedHttp;

export function withTikTokHttp<T>(http: TikTokHttp, fn: () => Promise<T>): Promise<T> {
  const prev = currentHttp;
  currentHttp = http;
  return Promise.resolve().then(fn).finally(() => { currentHttp = prev; });
}

const WEB_BASE = 'https://www.tiktok.com';

/** TikTok's web app id. Required on every /api/ call or it answers with an error. */
const AID = '1988';

/** Largest page TikTok will serve. Fewer, fuller pages beat many small ones:
 *  each request re-pays request/response headers and a proxy round trip. */
export const MAX_PAGE_SIZE = 30;

/**
 * Embed pages are ~330KB and carry the video list. Profile HTML is smaller
 * but we keep one ceiling so a Frontity blob is never truncated mid-object.
 */
const PROFILE_HTML_MAX_BYTES = 512 * 1024;
/** JSON pages are small; anything larger than this is a captcha/error wall. */
const JSON_MAX_BYTES = 512 * 1024;

/** Modelled bytes for the traffic pre-authorisation, per requested result. */
export const ESTIMATED_BYTES_PER_RESULT = 7 * 1024;
/** Modelled fixed cost of a scrape (one embed / profile page). */
export const ESTIMATED_LOOKUP_BYTES = 360 * 1024;

export function estimateScrapeBytes(limit: number, needsLookup: boolean): number {
  return Math.max(0, limit) * ESTIMATED_BYTES_PER_RESULT + (needsLookup ? ESTIMATED_LOOKUP_BYTES : 0);
}

// --- secUid cache -----------------------------------------------------------

interface CacheEntry<T> { value: T; expiresAt: number }

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const secUidCache = new Map<string, CacheEntry<string>>();
const challengeIdCache = new Map<string, CacheEntry<string>>();
/** First-page items lifted out of the profile HTML we already paid for. */
const ssrItemCache = new Map<string, any[]>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { map.delete(key); return null; }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + DEFAULT_TTL_MS });
}

/** Test seam. */
export function clearLookupCaches(): void {
  secUidCache.clear();
  challengeIdCache.clear();
  ssrItemCache.clear();
}

/** Walk TikTok's rehydration blob for ItemStruct-shaped videos. */
export function itemsFromRehydration(html: string): any[] {
  const data = extractRehydrationJson(html);
  if (!data) return [];
  const items: any[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const o = node as Record<string, unknown>;
    const id = o.id != null ? String(o.id) : '';
    const video = o.video;
    if (/^\d{6,}$/.test(id) && video && typeof video === 'object') {
      if (!seen.has(id)) { seen.add(id); items.push({ ...o, id }); }
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);
  return items;
}

export function takeSsrItems(handle: string): any[] {
  const clean = handle.replace(/^@/, '').trim().toLowerCase();
  const items = ssrItemCache.get(clean) ?? [];
  ssrItemCache.delete(clean);
  return items;
}

// --- Common query params ----------------------------------------------------

function baseParams(): Record<string, string> {
  return {
    aid: AID,
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_platform: 'Win32',
    channel: 'tiktok_web',
    device_platform: 'web_pc',
    os: 'windows',
    region: 'US',
    priority_region: 'US',
    language: 'en',
  };
}

function buildUrl(path: string, params: Record<string, string | number>): string {
  const qs = new URLSearchParams({ ...baseParams() } as Record<string, string>);
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `${WEB_BASE}${path}?${qs.toString()}`;
}

/** yt-dlp's device_id range. A bad id makes /api/creator/item_list loop the same page. */
function webDeviceId(): string {
  const lo = 7_250_000_000_000_000_000n;
  const hi = 7_325_099_899_999_994_577n;
  const span = hi - lo;
  const r = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  return String(lo + (r % span));
}

function randomHex(n: number): string {
  let s = '';
  while (s.length < n) s += Math.random().toString(16).slice(2);
  return s.slice(0, n);
}

/**
 * yt-dlp TikTokUserIE._build_web_query. First cursor is Date.now() ms, not 0.
 * This is the list endpoint that still returns itemList when TLS looks like Chrome.
 */
/** Lift the numeric challenge id out of an embed tag page. */
export function challengeIdFromFrontity(html: string): string | null {
  const data = extractFrontityJson(html);
  if (!data) return null;
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const o = node as Record<string, unknown>;
    const info = o.embedInfo;
    if (info && typeof info === 'object') {
      const id = (info as { id?: unknown }).id;
      if (id != null && /^\d{3,}$/.test(String(id))) found.push(String(id));
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);
  return found[0] ?? null;
}

/**
 * yt-dlp / web-app hashtag latest feed. Requires X-Bogus (impersonate-http).
 * `from_page=hashtag` is what the live 2026-08-13 probe used.
 */
export function challengeItemListUrl(challengeId: string, cursor: string | number, count: number): string {
  const qs = new URLSearchParams({
    aid: AID,
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    challengeID: challengeId,
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    count: String(count),
    coverFormat: '2',
    cursor: String(cursor),
    device_id: webDeviceId(),
    device_platform: 'web_pc',
    focus_state: 'true',
    from_page: 'hashtag',
    history_len: '2',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    language: 'en',
    os: 'windows',
    priority_region: '',
    referer: '',
    region: 'US',
    screen_height: '1080',
    screen_width: '1920',
    tz_name: 'UTC',
    webcast_language: 'en',
  });
  return `${WEB_BASE}/api/challenge/item_list/?${qs.toString()}`;
}

export function creatorItemListUrl(secUid: string, cursorMs: string | number, count: number): string {
  const qs = new URLSearchParams({
    aid: AID,
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0 (Windows)',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    count: String(count),
    cursor: String(cursorMs),
    device_id: webDeviceId(),
    device_platform: 'web_pc',
    focus_state: 'true',
    from_page: 'user',
    history_len: '2',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    language: 'en',
    os: 'windows',
    priority_region: '',
    referer: '',
    region: 'US',
    screen_height: '1080',
    screen_width: '1920',
    secUid,
    type: '1',
    tz_name: 'UTC',
    verifyFp: `verify_${randomHex(7)}`,
    webcast_language: 'en',
  });
  return `${WEB_BASE}/api/creator/item_list/?${qs.toString()}`;
}

function apiHeaders(referer: string): Record<string, string> {
  return { Referer: referer, Origin: WEB_BASE };
}

// --- Hidden page JSON -------------------------------------------------------

const REHYDRATION_MARKER = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
const FRONTITY_MARKER = '__FRONTITY_CONNECT_STATE__';

/**
 * Pull a JSON object that starts after `marker`. The closing tag may be
 * missing on an early-aborted read, so the object is extracted by
 * brace-balancing from the first `{`. Truncation yields null.
 */
export function extractJsonAfterMarker(html: string, marker: string): any | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
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

export function extractRehydrationJson(html: string): any | null {
  return extractJsonAfterMarker(html, REHYDRATION_MARKER);
}

export function extractFrontityJson(html: string): any | null {
  return extractJsonAfterMarker(html, FRONTITY_MARKER);
}

/** True once enough of the page has arrived to hold a complete blob. */
function pageBlobComplete(text: string): boolean {
  if (text.includes(FRONTITY_MARKER)) return extractFrontityJson(text) !== null;
  if (text.includes(REHYDRATION_MARKER)) return extractRehydrationJson(text) !== null;
  return false;
}

/**
 * TikTok item IDs are snowflakes: the high 32 bits are a unix timestamp.
 * Embed playlist rows omit createTime; this recovers it so recency filters work.
 */
export function createTimeFromItemId(id: string): number | null {
  try {
    const ts = Number(BigInt(id) >> 32n);
    if (ts > 1_450_000_000 && ts < 2_200_000_000) return ts;
    return null;
  } catch {
    return null;
  }
}

/** Map an embed `videoList[]` row onto the ItemStruct shape the rest of the pipeline expects. */
export function embedVideoToItem(raw: any, followers?: number | null): any | null {
  const id = raw?.id != null ? String(raw.id) : '';
  if (!/^\d{6,}$/.test(id)) return null;
  const handle = typeof raw.authorUniqueId === 'string' ? raw.authorUniqueId : undefined;
  return {
    id,
    desc: typeof raw.desc === 'string' ? raw.desc : '',
    createTime: createTimeFromItemId(id) ?? undefined,
    author: { uniqueId: handle, nickname: handle },
    authorStats: typeof followers === 'number' ? { followerCount: followers } : {},
    stats: {
      playCount: toNum(raw.playCount),
      diggCount: toNum(raw.diggCount ?? raw.likeCount),
      commentCount: toNum(raw.commentCount),
      shareCount: toNum(raw.shareCount),
      collectCount: toNum(raw.collectCount),
    },
    video: {
      cover: raw.coverUrl || raw.originCoverUrl || raw.dynamicCoverUrl || '',
      originCover: raw.originCoverUrl,
      dynamicCover: raw.dynamicCoverUrl,
    },
  };
}

function followersFromFrontity(data: any): number | null {
  const found: number[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const o = node as Record<string, unknown>;
    if (typeof o.followerCount === 'number' && typeof o.uniqueId === 'string') {
      found.push(o.followerCount);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);
  return found[0] ?? null;
}

/** Lift embed playlist videos out of `__FRONTITY_CONNECT_STATE__`. */
export function itemsFromFrontity(html: string): any[] {
  const data = extractFrontityJson(html);
  if (!data) return [];
  const followers = followersFromFrontity(data);
  const items: any[] = [];
  const seen = new Set<string>();
  const take = (raw: any): void => {
    const item = embedVideoToItem(raw, followers);
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const looksLikePlaylist = node.length > 0 && node.some((row: any) =>
        row && typeof row === 'object' && row.id && (row.coverUrl || row.playCount != null) && row.authorUniqueId,
      );
      if (looksLikePlaylist) {
        for (const row of node) take(row);
        return;
      }
      for (const n of node) walk(n);
      return;
    }
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.videoList)) {
      for (const row of o.videoList) take(row);
    }
    for (const k of Object.keys(o)) {
      if (k === 'videoList') continue;
      walk(o[k]);
    }
  };
  walk(data);
  return items;
}

export function embedPageUrl(sourceType: SourceKind, query: string): string {
  const q = query.replace(/^[@#]/, '').trim();
  if (sourceType === 'creator') return `${WEB_BASE}/embed/@${encodeURIComponent(q)}`;
  if (sourceType === 'hashtag') return `${WEB_BASE}/embed/tag/${encodeURIComponent(q)}`;
  return `${WEB_BASE}/embed/search/${encodeURIComponent(q)}`;
}

/**
 * Public embed pages are the working unsigned path (2026-08):
 * `/embed/@handle` and `/embed/tag/x` return a Frontity blob with videoList.
 * `/api/post/item_list` and signed in-page XHR both come back 200 / 0 bytes.
 */
export async function fetchEmbedItems(
  sourceType: SourceKind,
  query: string,
  req: PageRequest,
): Promise<{ items: any[]; notices: string[] }> {
  const getter = currentHttp.getText ?? unsignedHttp.getText;
  const q = query.replace(/^[@#]/, '').trim();
  // Search embed 404s. A keyword that is also a public hashtag works via /embed/tag/.
  const urls = sourceType === 'keyword' && q
    ? [`${WEB_BASE}/embed/tag/${encodeURIComponent(q)}`]
    : [embedPageUrl(sourceType, query)];

  for (const url of urls) {
    const res = await getter!(url, {
      Accept: 'text/html,application/xhtml+xml',
      Referer: `${WEB_BASE}/`,
    });
    if (!res.ok || !res.text) continue;
    const cid = challengeIdFromFrontity(res.text);
    if (cid && sourceType !== 'creator') {
      const cacheKey = q.toLowerCase();
      if (cacheKey) cacheSet(challengeIdCache, cacheKey, cid);
    }
    let items = itemsFromFrontity(res.text);
    if (!items.length && !cid) continue;
    if (!items.length) continue;

    // Embed playlists mix viral + recent. Newest-first so a small limit
    // does not spend the page on a three-year-old pinned hit.
    items.sort((a, b) => Number(b.createTime ?? 0) - Number(a.createTime ?? 0));

    const cutoffSec = req.postedAfter ? Math.floor(req.postedAfter.getTime() / 1000) : null;
    if (cutoffSec != null) {
      items = items.filter(it => {
        const ts = Number(it.createTime);
        return !Number.isFinite(ts) || ts >= cutoffSec;
      });
    }
    return { items: items.slice(0, req.limit), notices: [] };
  }
  return { items: [], notices: [] };
}

// --- Creator ----------------------------------------------------------------

export interface CreatorIdentity {
  secUid: string;
  handle: string;
  followers: number | null;
}

/**
 * Resolve a handle to its secUid, which every post query needs.
 *
 * Costs one early-aborted profile read, then nothing for 24h. `stopWhen` ends
 * the transfer the moment the rehydration object closes — typically well under
 * 100KB of a ~1.4MB page.
 */
export function identityFromUserDetail(json: any, fallbackHandle: string): CreatorIdentity | null {
  const info = json?.userInfo;
  const inner = info?.user ?? info;
  const secUid = inner?.secUid;
  if (typeof secUid !== 'string' || !secUid) return null;
  const followers = info?.stats?.followerCount;
  return {
    secUid,
    handle: typeof inner?.uniqueId === 'string' ? inner.uniqueId : fallbackHandle,
    followers: typeof followers === 'number' ? followers : null,
  };
}

export async function resolveCreator(handle: string): Promise<CreatorIdentity | null> {
  const clean = handle.replace(/^@/, '').trim().toLowerCase();
  if (!clean) return null;

  const cached = cacheGet(secUidCache, clean);
  if (cached) return { secUid: cached, handle: clean, followers: null };

  // HTML navigation first. Signed in-page /api/user/detail is often an empty
  // 200 in headless; the profile document is what the Apify actor actually
  // hydrates, and it already contains secUid + the first item page.
  const getter = currentHttp.getText ?? unsignedHttp.getText;
  const res = await getter!(`${WEB_BASE}/@${encodeURIComponent(clean)}`, {
    Accept: 'text/html,application/xhtml+xml',
  });
  if (res.ok && res.text) {
    const ssrItems = itemsFromRehydration(res.text);
    console.log(`[tiktok-web] profile html ${res.text.length}B rehydrationItems=${ssrItems.length} hasBlob=${res.text.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')}`);
    if (ssrItems.length) ssrItemCache.set(clean, ssrItems);
    const data = extractRehydrationJson(res.text);
    const user = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
    const secUid = user?.user?.secUid;
    if (typeof secUid === 'string' && secUid) {
      cacheSet(secUidCache, clean, secUid);
      const followers = user?.stats?.followerCount;
      return {
        secUid,
        handle: user?.user?.uniqueId ?? clean,
        followers: typeof followers === 'number' ? followers : null,
      };
    }
    if (ssrItems.length) {
      cacheSet(secUidCache, clean, 'ssr');
      return { secUid: 'ssr', handle: clean, followers: null };
    }
  }

  const api = await currentHttp.getJson(
    buildUrl('/api/user/detail/', { uniqueId: clean }),
    apiHeaders(`${WEB_BASE}/@${clean}`),
  );
  const fromApi = identityFromUserDetail(api.json, clean);
  if (fromApi) {
    cacheSet(secUidCache, clean, fromApi.secUid);
    return fromApi;
  }
  return null;
}

// --- Paged item fetching ----------------------------------------------------

export interface PageRequest {
  limit: number;
  /** Stop as soon as an item older than this is seen (feeds are newest-first). */
  postedAfter?: Date;
}

interface RawPage {
  items: any[];
  hasMore: boolean;
  cursor: string;
  statusCode?: number;
}

/** Pull ItemStructs out of any TikTok list payload the web app uses. */
export function itemsFromApiPayload(json: any): any[] {
  if (!json || typeof json !== 'object') return [];
  const list = json.itemList
    ?? json.itemListByHashTagName
    ?? json.itemListBySearch
    ?? json.aweme_list
    ?? json.item_list
    ?? json.data
    ?? [];
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const row of list) {
    const item = row?.item ?? row;
    if (!item || typeof item !== 'object') continue;
    const id = item.id != null ? String(item.id) : '';
    if (/^\d{6,}$/.test(id)) out.push({ ...item, id });
  }
  return out;
}

export type SourceKind = 'creator' | 'hashtag' | 'keyword';

export function tiktokSourceUrl(sourceType: SourceKind, query: string): string {
  const q = query.replace(/^[@#]/, '').trim();
  if (sourceType === 'creator') return `${WEB_BASE}/@${encodeURIComponent(q)}`;
  if (sourceType === 'hashtag') return `${WEB_BASE}/tag/${encodeURIComponent(q)}`;
  return `${WEB_BASE}/search?q=${encodeURIComponent(q)}`;
}

/** XHR the real web app fires after hydrating each surface. */
export function xhrPatternFor(sourceType: SourceKind): RegExp {
  if (sourceType === 'creator') return /\/api\/post\/item_list/;
  if (sourceType === 'hashtag') return /\/api\/challenge\/item_list/;
  return /\/api\/search\/(item|general)/;
}

export function dedupeItems(items: any[]): any[] {
  const byId = new Map<string, any>();
  for (const it of items) {
    const id = it?.id != null ? String(it.id) : '';
    if (id && !byId.has(id)) byId.set(id, it);
  }
  return [...byId.values()];
}

async function fetchItemPage(url: string, referer: string): Promise<RawPage | null> {
  const { json } = await currentHttp.getJson(url, apiHeaders(referer));
  if (!json) return null;
  const items = itemsFromApiPayload(json);
  let cursor = String(json.cursor ?? json.max_cursor ?? '');
  if (!cursor && items.length) {
    const last = items[items.length - 1];
    const ts = Number(last?.createTime);
    if (Number.isFinite(ts) && ts > 0) cursor = String(Math.floor(ts * 1000));
  }
  return {
    items,
    hasMore: json.hasMore === true || json.has_more === 1 || json.hasMorePrevious === true,
    cursor,
    statusCode: typeof json.statusCode === 'number' ? json.statusCode : undefined,
  };
}

/**
 * Walk pages until the limit, the watermark, or the end of the feed.
 *
 * The watermark check is what makes an incremental refresh nearly free: a
 * creator feed is newest-first, so the first item older than the watermark
 * proves every remaining item is too, and the next page is never requested.
 */
async function collectPages(
  makeUrl: (cursor: string, count: number) => string,
  referer: string,
  req: PageRequest,
): Promise<{ items: any[]; notices: string[] }> {
  const out: any[] = [];
  const notices: string[] = [];
  const cutoffSec = req.postedAfter ? Math.floor(req.postedAfter.getTime() / 1000) : null;
  let cursor = '0';

  while (out.length < req.limit) {
    const count = Math.min(MAX_PAGE_SIZE, req.limit - out.length);
    const page = await fetchItemPage(makeUrl(cursor, count), referer);
    if (!page) {
      notices.push('TikTok returned an unparseable response (rate limit, captcha wall, or blocked exit node)');
      break;
    }
    if (page.items.length === 0) {
      if (out.length === 0) {
        notices.push(
          page.statusCode && page.statusCode !== 0
            ? `TikTok API status ${page.statusCode} — the query may be invalid, private, or region-blocked`
            : 'TikTok returned no items for this query',
        );
      }
      break;
    }

    let hitWatermark = false;
    for (const item of page.items) {
      if (cutoffSec != null && Number(item?.createTime) < cutoffSec) { hitWatermark = true; break; }
      out.push(item);
      if (out.length >= req.limit) break;
    }
    // Older-than-watermark reached: every later page is older still.
    if (hitWatermark || !page.hasMore || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }

  return { items: out, notices };
}

export async function fetchCreatorPosts(
  identity: CreatorIdentity,
  req: PageRequest,
): Promise<{ items: any[]; notices: string[] }> {
  const ssr = takeSsrItems(identity.handle);
  if (ssr.length >= req.limit || identity.secUid === 'ssr') {
    return { items: ssr.slice(0, req.limit), notices: ssr.length ? [] : ['TikTok profile page had no videos'] };
  }
  const referer = `${WEB_BASE}/@${identity.handle}`;
  const remaining = { ...req, limit: req.limit - ssr.length };
  // yt-dlp user path first. /api/post/item_list is the empty-200 endpoint.
  const rest = await collectPages(
    (cursor, count) => creatorItemListUrl(
      identity.secUid,
      cursor === '0' ? Date.now() : cursor,
      count,
    ),
    referer,
    remaining,
  );
  if (rest.items.length) {
    return { items: [...ssr, ...rest.items].slice(0, req.limit), notices: rest.notices };
  }
  const legacy = await collectPages(
    (cursor, count) => buildUrl('/api/post/item_list/', {
      secUid: identity.secUid,
      count,
      cursor,
    }),
    referer,
    remaining,
  );
  return { items: [...ssr, ...legacy.items].slice(0, req.limit), notices: legacy.notices };
}

function statsMissing(item: any): boolean {
  const n = toNum(item?.stats?.diggCount ?? item?.diggCount);
  return n === 0 && !item?.stats?.diggCount && !item?.diggCount;
}

/**
 * Embed playlist rows have views but not likes. Video pages carry the full
 * itemStruct when TLS impersonation is on. Capped — each page is ~150-300KB.
 */
export async function hydrateItemStats(items: any[], maxPages = 8): Promise<any[]> {
  const getter = currentHttp.getText;
  if (!getter || maxPages <= 0) return items;
  let used = 0;
  const out = items.map(it => ({ ...it }));
  for (const item of out) {
    if (used >= maxPages) break;
    if (!statsMissing(item)) continue;
    const handle = item?.author?.uniqueId ?? item?.authorUniqueId;
    const id = item?.id != null ? String(item.id) : '';
    if (!handle || !/^\d{6,}$/.test(id)) continue;
    used++;
    const res = await getter(`${WEB_BASE}/@${encodeURIComponent(String(handle))}/video/${id}`, {
      Accept: 'text/html,application/xhtml+xml',
      Referer: `${WEB_BASE}/@${handle}`,
    });
    if (!res.ok || !res.text) continue;
    const data = extractRehydrationJson(res.text);
    const struct = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!struct || typeof struct !== 'object') continue;
    if (struct.stats) item.stats = { ...item.stats, ...struct.stats };
    if (struct.authorStats) item.authorStats = { ...item.authorStats, ...struct.authorStats };
    if (struct.desc && !item.desc) item.desc = struct.desc;
    if (struct.createTime && !item.createTime) item.createTime = struct.createTime;
    if (struct.video) item.video = { ...item.video, ...struct.video };
  }
  return out;
}

export async function resolveChallengeId(name: string): Promise<string | null> {
  const clean = name.replace(/^#/, '').trim().toLowerCase();
  if (!clean) return null;
  const cached = cacheGet(challengeIdCache, clean);
  if (cached) return cached;

  const { json } = await currentHttp.getJson(
    buildUrl('/api/challenge/detail/', { challengeName: clean }),
    apiHeaders(`${WEB_BASE}/tag/${clean}`),
  );
  const id = json?.challengeInfo?.challenge?.id ?? json?.challengeInfo?.challenge?.challengeID;
  if (id != null && /^\d{3,}$/.test(String(id))) {
    cacheSet(challengeIdCache, clean, String(id));
    return String(id);
  }

  const getter = currentHttp.getText ?? unsignedHttp.getText;
  const page = await getter!(`${WEB_BASE}/embed/tag/${encodeURIComponent(clean)}`, {
    Accept: 'text/html,application/xhtml+xml',
    Referer: `${WEB_BASE}/`,
  });
  const fromEmbed = page.ok && page.text ? challengeIdFromFrontity(page.text) : null;
  if (fromEmbed) {
    cacheSet(challengeIdCache, clean, fromEmbed);
    return fromEmbed;
  }
  return null;
}

export async function fetchHashtagPosts(
  name: string,
  challengeId: string,
  req: PageRequest,
): Promise<{ items: any[]; notices: string[] }> {
  const clean = name.replace(/^#/, '').trim().toLowerCase();
  return collectPages(
    (cursor, count) => challengeItemListUrl(challengeId, cursor, count),
    `${WEB_BASE}/tag/${clean}`,
    req,
  );
}

export async function fetchSearchPosts(
  keyword: string,
  req: PageRequest,
): Promise<{ items: any[]; notices: string[] }> {
  const q = keyword.trim();
  const referer = `${WEB_BASE}/search?q=${encodeURIComponent(q)}`;
  const out: any[] = [];
  const notices: string[] = [];
  let offset = 0;

  const cutoffSec = req.postedAfter ? Math.floor(req.postedAfter.getTime() / 1000) : null;

  while (out.length < req.limit) {
    const count = Math.min(MAX_PAGE_SIZE, req.limit - out.length);
    const { json } = await currentHttp.getJson(
      buildUrl('/api/search/item/full/', { keyword: q, offset, count, search_source: 'normal_search' }),
      apiHeaders(referer),
    );
    if (!json) {
      notices.push('TikTok search returned an unparseable response (rate limit, captcha wall, or blocked exit node)');
      break;
    }
    // Search wraps each hit: { item: {...} } under item_list or data.
    const rows: any[] = Array.isArray(json.item_list) ? json.item_list
      : Array.isArray(json.data) ? json.data
      : [];
    const items = rows.map(r => r?.item ?? r).filter(Boolean);
    if (items.length === 0) {
      if (out.length === 0) notices.push(`TikTok search returned no results for "${q}"`);
      break;
    }
    // Search is not strictly newest-first, so old hits are skipped rather
    // than treating the first one as "the rest of the feed is older too".
    for (const item of items) {
      if (cutoffSec != null && Number(item?.createTime) < cutoffSec) continue;
      out.push(item);
      if (out.length >= req.limit) break;
    }
    if (out.length >= req.limit) break;
    if (json.has_more !== 1 && json.hasMore !== true) break;
    offset = Number(json.cursor ?? json.offset ?? offset + items.length);
  }

  return { items: out, notices };
}

// --- Normalisation ----------------------------------------------------------

/**
 * Map a web-API item onto the shape `normalizeTikTok` already understands, so
 * swapping providers cannot change what lands in the database.
 *
 * `raw` is TRIMMED to the fields anything downstream reads. A web item carries
 * several KB of playback URLs, bitrate ladders and sticker metadata per video,
 * all of it dead weight in a persisted column and none of it used.
 */
export function webItemToApifyShape(item: any): any {
  const author = item?.author ?? {};
  const authorStats = item?.authorStats ?? {};
  const stats = item?.stats ?? item?.statsV2 ?? {};
  const video = item?.video ?? {};
  const handle = author.uniqueId || author.nickname || 'unknown';
  const id = String(item?.id ?? '');

  return {
    id,
    text: item?.desc ?? '',
    createTime: Number(item?.createTime) || undefined,
    webVideoUrl: `https://www.tiktok.com/@${handle}/video/${id}`,
    authorMeta: {
      name: handle,
      nickName: author.nickname,
      fans: typeof authorStats.followerCount === 'number' ? authorStats.followerCount : undefined,
    },
    videoMeta: {
      // Platform CDN cover only. Nothing is downloaded through the proxy, so
      // there is no key-value-store copy — coverDownloadUrl stays null and
      // ingest fetches this URL direct, off-proxy, on demand.
      originalCoverUrl: video.cover || video.originCover || video.dynamicCover || '',
      duration: video.duration,
    },
    playCount: toNum(stats.playCount),
    diggCount: toNum(stats.diggCount),
    commentCount: toNum(stats.commentCount),
    shareCount: toNum(stats.shareCount),
    collectCount: toNum(stats.collectCount),
  };
}

function toNum(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function normalizeWebItems(items: any[]): NormalizedVideo[] {
  return items
    .map(item => {
      try {
        return normalizeTikTok(webItemToApifyShape(item));
      } catch {
        return null;
      }
    })
    .filter((v): v is NormalizedVideo => v !== null && !!v.externalId);
}
