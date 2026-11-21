// ---------------------------------------------------------------------------
// Instagram Reels — anonymous web scrape through the residential proxy.
//
// Recipe probed live on 2026-11-21 (SLA-1630, SLA-1635, SLA-1637):
//
//   * `GET /<user>/reels/` with browser document headers, no cookies, answers
//     200 through the residential exit. Its `<script type="application/json"
//     data-sjs>` blobs carry `xig_user_by_username.polaris_clips_connection`:
//     the LATEST 12 Reels with code, play_count, like_count, comment_count,
//     cover (`display_uri`) and pin state, plus the profile's follower_count.
//   * `GET /reel/<code>/` carries the full media object under
//     `xig_polaris_media.if_not_gated_logged_out`: caption, taken_at,
//     video_versions (progressive MP4), clips_metadata (audio), dash manifest.
//
// What does NOT work logged out, so do not spend traffic re-trying it:
//   * Pagination past 12. The Reels-tab GraphQL query answers 200 with
//     `xig_user_by_username: null`; `web_profile_info`, `feed/user`,
//     `clips/user` and `?__a=1` are 404 / require_login. A Reels source is
//     therefore a "latest 12" window, which is what daily outlier tracking
//     needs anyway.
//   * Hashtag / keyword search — login-walled.
//
// Traffic decisions:
//   * The media pk encodes its creation time, so the tab page alone gives a
//     postedAt good to a few minutes. Recency and the incremental watermark
//     are applied BEFORE any per-Reel page is fetched; a refresh of a quiet
//     account costs one tab page.
//   * Both pages stop reading once the blob we need has closed (~70% of the
//     document).
// ---------------------------------------------------------------------------

import type { NormalizedVideo } from '../../normalizers.js';
import { proxyFetch, proxyFetchBuffer } from './proxy-http.js';

export interface InstagramHttpResult {
  status: number;
  ok: boolean;
  text: string;
  bytes: number;
}

export interface InstagramHttpBufferResult {
  status: number;
  ok: boolean;
  buffer: Buffer;
  bytes: number;
}

/** Pluggable transport: tests inject fixtures, production goes through the proxy. */
export interface InstagramHttp {
  getText(url: string, opts?: { stopAfter?: string }): Promise<InstagramHttpResult>;
  getBuffer(url: string, maxBytes: number): Promise<InstagramHttpBufferResult>;
}

const WEB_BASE = 'https://www.instagram.com';

/** Instagram's own epoch for media ids (2011-08-24T21:07:01.721Z). */
const IG_ID_EPOCH_MS = 1314220021721;

/** Pages are ~650KB; the blobs we read close by ~510KB. */
const PAGE_MAX_BYTES = 1024 * 1024;

/** The Reels tab only ever yields this many items logged out. */
export const INSTAGRAM_TAB_PAGE_SIZE = 12;

/** Modelled bytes for the traffic pre-authorisation. */
export const ESTIMATED_IG_TAB_BYTES = 480 * 1024;
export const ESTIMATED_IG_REEL_PAGE_BYTES = 520 * 1024;

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

const DOCUMENT_HEADERS: Record<string, string> = {
  'User-Agent': SAFARI_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** True once `marker` appeared and the script element holding it has closed. */
export function blobClosed(text: string, marker: string): boolean {
  const at = text.indexOf(marker);
  return at >= 0 && text.indexOf('</script>', at) > at;
}

export const proxyInstagramHttp: InstagramHttp = {
  async getText(url, opts) {
    const marker = opts?.stopAfter;
    const r = await proxyFetch(url, {
      headers: DOCUMENT_HEADERS,
      maxBytes: PAGE_MAX_BYTES,
      stopWhen: marker ? (t) => blobClosed(t, marker) : undefined,
      timeoutMs: 30_000,
    });
    return { status: r.status, ok: r.ok, text: r.text, bytes: r.bytes };
  },
  async getBuffer(url, maxBytes) {
    const headers = { 'User-Agent': SAFARI_UA, Accept: 'video/mp4,video/*,*/*', Referer: `${WEB_BASE}/` };
    // The signed CDN URL answers datacenter IPs (probed 2026-11-21), so try it
    // direct first: an MP4 is ~4MB, and on the proxy that is the whole bill.
    const direct = await fetchDirect(url, headers, maxBytes).catch(() => null);
    if (direct?.ok) return direct;
    const r = await proxyFetchBuffer(url, { headers, maxBytes, compress: false, timeoutMs: 60_000 });
    return { status: r.status, ok: r.ok, buffer: r.buffer, bytes: r.bytes };
  },
};

/** Unmetered GET off the proxy; reads at most maxBytes. */
async function fetchDirect(
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<InstagramHttpBufferResult> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, ok: false, buffer: Buffer.alloc(0), bytes: 0 };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buffer = Buffer.concat(chunks);
  return { status: res.status, ok: true, buffer, bytes: 0 };
}

// --- identity ----------------------------------------------------------------

/**
 * `@user`, `user`, or any instagram.com URL under the profile → `user`.
 * Null for anything that is not a valid Instagram username.
 */
export function parseInstagramUsername(query: string): string | null {
  let q = query.trim();
  // `/popular/<user>/` is Instagram's logged-out SEO landing for a profile.
  const url = q.match(/instagram\.com\/(?:popular\/)?([^/?#]+)/i);
  if (url?.[1]) q = url[1];
  q = q.replace(/^@/, '').toLowerCase();
  if (['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts'].includes(q)) return null;
  return /^[a-z0-9._]{1,30}$/.test(q) ? q : null;
}

/** Shortcode out of /reel/<code>/, /reels/<code>/, /p/<code>/ or /tv/<code>/. */
export function extractInstagramShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/i);
  return m?.[1] ?? null;
}

export function isInstagramUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.|m\.)?instagram\.com\//i.test(url);
}

export function reelUrl(code: string): string {
  return `${WEB_BASE}/reel/${code}/`;
}

/** Creation time encoded in a media pk (top 41 bits = ms since the IG epoch). */
export function postedAtFromPk(pk: unknown): Date | null {
  if (pk == null) return null;
  const digits = String(pk).match(/^\d{10,25}/)?.[0];
  if (!digits) return null;
  try {
    const ms = Number(BigInt(digits) >> 23n) + IG_ID_EPOCH_MS;
    return Number.isFinite(ms) && ms > IG_ID_EPOCH_MS ? new Date(ms) : null;
  } catch {
    return null;
  }
}

// --- page parsing --------------------------------------------------------------

const SJS_RE = /<script type="application\/json"[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/g;

/** Every data-sjs blob that parses. Blobs mentioning none of `markers` are skipped unparsed. */
export function extractSjsBlobs(html: string, markers: string[] = []): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(SJS_RE)) {
    const body = m[1];
    if (!body || (markers.length && !markers.some(k => body.includes(k)))) continue;
    try { out.push(JSON.parse(body)); } catch { /* truncated or not JSON */ }
  }
  return out;
}

function* walk(o: unknown): Generator<Record<string, any>> {
  if (Array.isArray(o)) {
    for (const v of o) yield* walk(v);
  } else if (o && typeof o === 'object') {
    yield o as Record<string, any>;
    for (const v of Object.values(o)) yield* walk(v);
  }
}

export interface InstagramProfile {
  username: string;
  pk: string | null;
  followers: number | null;
  isPrivate: boolean;
}

export interface InstagramTabReel {
  code: string;
  pk: string | null;
  plays: number;
  likes: number | null;
  comments: number;
  coverUrl: string;
  pinned: boolean;
  countsHidden: boolean;
}

export interface ReelsTabPage {
  profile: InstagramProfile | null;
  reels: InstagramTabReel[];
  hasNextPage: boolean;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return v != null && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

/**
 * Read the Reels tab. `like_and_view_counts_disabled` makes Instagram serve a
 * placeholder like_count (3 on every hidden Reel), so likes become null there.
 */
export function parseReelsTab(html: string, username: string): ReelsTabPage {
  let profile: InstagramProfile | null = null;
  const reels: InstagramTabReel[] = [];
  const seen = new Set<string>();
  let hasNextPage = false;

  for (const blob of extractSjsBlobs(html, ['polaris_clips_connection', 'follower_count'])) {
    for (const node of walk(blob)) {
      if (!profile && typeof node.follower_count === 'number' && String(node.username ?? '').toLowerCase() === username) {
        profile = {
          username,
          pk: node.pk != null ? String(node.pk) : (node.id != null ? String(node.id) : null),
          followers: num(node.follower_count),
          isPrivate: Boolean(node.is_private),
        };
      }
      const conn = node.polaris_clips_connection;
      if (!conn || !Array.isArray(conn.edges)) continue;
      hasNextPage = hasNextPage || Boolean(conn.page_info?.has_next_page);
      for (const edge of conn.edges) {
        const n = edge?.node;
        const code = typeof n?.code === 'string' ? n.code : null;
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const hidden = Boolean(n.like_and_view_counts_disabled);
        reels.push({
          code,
          pk: n.pk != null ? String(n.pk) : null,
          plays: num(n.play_count ?? n.view_count ?? n.ig_play_count) ?? 0,
          likes: hidden ? null : num(n.like_count),
          comments: num(n.comment_count) ?? 0,
          coverUrl: typeof n.display_uri === 'string' ? n.display_uri : '',
          pinned: Array.isArray(n.clips_tab_pinned_user_ids) && n.clips_tab_pinned_user_ids.length > 0,
          countsHidden: hidden,
        });
      }
    }
  }

  // Follower count only, when the profile blob was not in the page.
  if (!profile) {
    const og = html.match(/<meta property="og:description" content="([\d.,]+)([KkMm]?) Followers/);
    if (og) {
      const base = Number(og[1]!.replace(/,/g, ''));
      const mult = /k/i.test(og[2] ?? '') ? 1e3 : /m/i.test(og[2] ?? '') ? 1e6 : 1;
      profile = { username, pk: null, followers: Number.isFinite(base) ? Math.round(base * mult) : null, isPrivate: false };
    }
  }

  return { profile, reels, hasNextPage };
}

/** The media object for `code` on a /reel/<code>/ page, or null. */
export function parseReelPage(html: string, code: string): Record<string, any> | null {
  for (const blob of extractSjsBlobs(html, [`"${code}"`])) {
    for (const node of walk(blob)) {
      if (node.code === code && (Array.isArray(node.video_versions) || node.media_type != null)) return node;
    }
  }
  return null;
}

/** Seconds, from the dash manifest or the efg tag on a video_versions URL. */
export function reelDurationSec(media: Record<string, any> | null): number | null {
  if (!media) return null;
  const direct = num(media.video_duration);
  if (direct) return direct;
  const iso = String(media.video_dash_manifest ?? '').match(/mediaPresentationDuration="PT(?:(\d+)M)?([\d.]+)S"/);
  if (iso) return Math.round(Number(iso[1] ?? 0) * 60 + Number(iso[2]));
  for (const v of Array.isArray(media.video_versions) ? media.video_versions : []) {
    const efg = typeof v?.url === 'string' ? new URL(v.url).searchParams.get('efg') : null;
    if (!efg) continue;
    try {
      const tag = JSON.parse(Buffer.from(efg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const d = num(tag?.duration_s);
      if (d) return d;
    } catch { /* not base64 JSON */ }
  }
  return null;
}

/** Progressive MP4 candidates. All rungs served logged out are the same 720p file today. */
export function reelVideoUrls(media: Record<string, any> | null): string[] {
  const list = Array.isArray(media?.video_versions) ? media!.video_versions : [];
  return [...new Set<string>(list.map((v: any) => v?.url).filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http')))];
}

function reelCoverUrl(media: Record<string, any> | null): string | null {
  const c = media?.image_versions2?.candidates;
  if (Array.isArray(c) && typeof c[0]?.url === 'string') return c[0].url;
  return typeof media?.display_uri === 'string' ? media.display_uri : null;
}

function reelSound(media: Record<string, any> | null, username: string): NormalizedVideo['sound'] {
  const meta = media?.clips_metadata;
  const music = meta?.music_info?.music_asset_info;
  if (music && (music.audio_asset_id || music.title)) {
    return {
      id: String(music.audio_asset_id ?? music.audio_cluster_id ?? music.title),
      title: String(music.title ?? 'licensed track'),
      author: String(music.display_artist ?? ''),
    };
  }
  const original = meta?.original_sound_info;
  if (original && (original.audio_asset_id || original.original_audio_title)) {
    return {
      id: String(original.audio_asset_id ?? `original:${username}`),
      title: String(original.original_audio_title ?? 'Original audio'),
      author: String(original.ig_artist?.username ?? username),
    };
  }
  return null;
}

/** Tab entry + (optional) hydrated media → the shared shape. */
export function normalizeReel(
  tab: InstagramTabReel,
  media: Record<string, any> | null,
  profile: InstagramProfile | null,
  username: string,
): NormalizedVideo {
  const takenAt = num(media?.taken_at);
  const postedAt = takenAt ? new Date(takenAt * 1000) : (postedAtFromPk(tab.pk ?? media?.pk) ?? new Date());
  const hidden = tab.countsHidden || Boolean(media?.like_and_view_counts_disabled);
  const likes = hidden ? null : (tab.likes ?? num(media?.like_count));
  const handle = String(media?.user?.username ?? username).toLowerCase();
  return {
    platform: 'reels',
    externalId: tab.code,
    url: reelUrl(tab.code),
    thumbnailUrl: reelCoverUrl(media) ?? tab.coverUrl,
    creatorHandle: handle,
    creatorFollowers: profile?.followers ?? null,
    caption: typeof media?.caption?.text === 'string' ? media.caption.text : '',
    postedAt: postedAt.toISOString(),
    views: tab.plays,
    likes: likes ?? 0,
    comments: Math.max(tab.comments, num(media?.comment_count) ?? 0),
    shares: null,
    saves: null,
    durationSec: reelDurationSec(media),
    transcript: null,
    transcriptSource: 'none',
    sound: reelSound(media, handle),
    // Compact on purpose: rawJson is persisted per video, and the media object
    // is ~50KB of expiring signed URLs and a dash manifest.
    raw: {
      source: 'instagram-web',
      code: tab.code,
      pk: tab.pk ?? (media?.pk != null ? String(media.pk) : null),
      pinned: tab.pinned,
      likesHidden: hidden,
      hydrated: Boolean(media),
      productType: media?.product_type ?? 'clips',
      aiLabel: media?.ai_label_info?.attribution_label_text ?? null,
    },
  };
}

// --- fetchers ------------------------------------------------------------------

async function getPage(
  http: InstagramHttp,
  url: string,
  ok: (text: string) => boolean,
  stopAfter: string,
  attempts = 3,
): Promise<{ text: string; status: number } | null> {
  let last: { text: string; status: number } | null = null;
  for (let i = 0; i < attempts; i++) {
    const r = await http.getText(url, { stopAfter });
    last = { text: r.text, status: r.status };
    if (r.ok && ok(r.text)) return last;
    // 302 → login wall and dropped tunnels clear on a fresh exit IP; the
    // gateway hands out a new one per connection.
    if (i < attempts - 1) await sleep(500 + Math.random() * 1500);
  }
  return last && ok(last.text) ? last : null;
}

export interface InstagramReelsRequest {
  limit: number;
  postedAfter?: Date;
  /** Per-Reel page reads for caption/date/duration. Default: every Reel kept. */
  hydrate?: number;
}

export interface InstagramReelsResult {
  items: NormalizedVideo[];
  rawCount: number;
  notices: string[];
}

export async function fetchCreatorReels(
  query: string,
  req: InstagramReelsRequest,
  http: InstagramHttp = proxyInstagramHttp,
): Promise<InstagramReelsResult> {
  const username = parseInstagramUsername(query);
  if (!username) {
    return { items: [], rawCount: 0, notices: [`"${query}" is not an Instagram username — pass @handle or an instagram.com profile URL`] };
  }

  const tab = await getPage(
    http,
    `${WEB_BASE}/${encodeURIComponent(username)}/reels/`,
    (t) => t.includes('polaris_clips_connection') || t.includes('"is_private":true'),
    'polaris_clips_connection',
  );
  if (!tab) {
    return {
      items: [],
      rawCount: 0,
      notices: [`Instagram did not serve @${username}'s Reels tab (login wall or missing account) — retry later or check the handle`],
    };
  }

  const page = parseReelsTab(tab.text, username);
  const notices: string[] = [];
  if (page.profile?.isPrivate) {
    return { items: [], rawCount: 0, notices: [`@${username} is a private Instagram account — nothing can be scraped`] };
  }
  if (!page.reels.length) {
    return { items: [], rawCount: 0, notices: [`@${username} has no public Reels`] };
  }

  const dated = page.reels.map(r => ({ r, at: postedAtFromPk(r.pk) }));
  let kept = dated;
  if (req.postedAfter) {
    const cutoff = req.postedAfter.getTime();
    kept = dated.filter(d => !d.at || d.at.getTime() >= cutoff);
  }
  kept.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  kept = kept.slice(0, Math.max(0, req.limit));

  const hydrateN = Math.min(kept.length, req.hydrate ?? kept.length);
  const items: NormalizedVideo[] = [];
  let missed = 0;
  for (let i = 0; i < kept.length; i++) {
    const { r } = kept[i]!;
    let media: Record<string, any> | null = null;
    if (i < hydrateN) {
      const p = await getPage(http, reelUrl(r.code), (t) => t.includes('xig_polaris_media') || t.includes(`"code":"${r.code}"`), 'xig_polaris_media', 2);
      media = p ? parseReelPage(p.text, r.code) : null;
      if (!media) missed++;
      if (i < hydrateN - 1) await sleep(300 + Math.random() * 700);
    }
    items.push(normalizeReel(r, media, page.profile, username));
  }

  if (page.hasNextPage && req.limit > page.reels.length && !req.postedAfter) {
    notices.push(`[info] Instagram serves only the latest ${INSTAGRAM_TAB_PAGE_SIZE} Reels without login — older Reels of @${username} are not reachable`);
  }
  if (missed) {
    notices.push(`[info] ${missed} of ${hydrateN} Reel pages did not load; those rows carry tab stats only (no caption, approximate date)`);
  }
  return { items, rawCount: page.reels.length, notices };
}

/** The media object for one Reel URL, with retries. */
export async function fetchReelMedia(
  url: string,
  http: InstagramHttp = proxyInstagramHttp,
): Promise<Record<string, any>> {
  const code = extractInstagramShortcode(url);
  if (!code) throw new Error(`Could not read an Instagram shortcode out of "${url}"`);
  const page = await getPage(http, reelUrl(code), (t) => t.includes('xig_polaris_media') || t.includes(`"code":"${code}"`), 'xig_polaris_media');
  const media = page ? parseReelPage(page.text, code) : null;
  if (!media) {
    throw new Error(`Instagram Reel page had no media for ${code} (http=${page?.status ?? 0}) — the post may be deleted, private, or login-walled`);
  }
  return media;
}

export function estimateInstagramScrapeBytes(limit: number, hydrate: number): number {
  return ESTIMATED_IG_TAB_BYTES + Math.min(Math.max(0, limit), hydrate, INSTAGRAM_TAB_PAGE_SIZE) * ESTIMATED_IG_REEL_PAGE_BYTES;
}
