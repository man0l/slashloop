// ---------------------------------------------------------------------------
// Proxy adapter — scrape TikTok directly through a rotating residential proxy.
//
// Why this exists: Apify bills per RESULT and hides the network behind an
// actor. This path bills per GIGABYTE and owns the network outright, which
// makes it dramatically cheaper — but only if every request is deliberate.
// So the adapter is built around a traffic budget instead of a spend cap:
//
//   * pre-authorise an ESTIMATE against the monthly GB cap before any request
//   * meter every response, prefer Content-Length (the compressed, billed size)
//   * record the ACTUAL bytes afterwards, split pro-rata across cost sharers
//
// Traffic decisions worth stating outright, because they are the difference
// between this path being cheap and it being a bad deal:
//
//   1. Covers are never downloaded. The platform CDN URL is stored and fetched
//      direct (off-proxy) by media ingest, for the handful of videos actually
//      displayed — instead of ~30KB x every video x every refresh, forever.
//   2. Video binaries pick the SMALLEST bitrate variant TikTok offers. The
//      ladder usually spans 3-5x; analysis and playback do not need the top
//      rung, and on a per-GB plan the top rung is the entire bill.
//   3. Incremental refreshes stop at the watermark mid-page, so a creator with
//      no new posts costs one small JSON response.
//   4. A single-video download reads the watch-page rehydration blob (the
//      same source hydrateItemStats uses). /api/item/detail answers 200/0B
//      even with Chrome TLS + X-Bogus — probed live 2026-08-14.
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import {
  bytesToCents, fmtBytes, recordTrafficBytes,
} from './bandwidth.js';
import { assertProxyBudget } from './budget.js';
import { proxyConfig } from './proxy-http.js';
import { createImpersonatedHttp } from './impersonate-http.js';
import {
  dedupeItems, estimateScrapeBytes, fetchCreatorPosts, fetchEmbedItems,
  fetchHashtagPosts, fetchSearchPosts, hydrateItemStats, normalizeWebItems,
  extractSlideshowImages, resolveChallengeId, resolveCreator, unsignedHttp,
  itemStructFromWatchHtml, withTikTokHttp,
  type TikTokHttp,
} from './tiktok-web.js';
import { splitSpend } from '../apify.js';
import {
  SlideshowPostError,
  type DownloadOptions, type DownloadResult, type ScrapeOptions, type ScrapeResult, type ScraperAdapter,
} from './types.js';

export const PROXY_PROVIDER_NAME = 'proxy';

/** Hard ceiling on one video download. Above this we would rather have no
 *  video than a surprise gigabyte. */
function maxVideoBytes(): number {
  const mb = Number(process.env.SCRAPER_PROXY_MAX_VIDEO_MB ?? 12);
  return (Number.isFinite(mb) && mb > 0 ? mb : 12) * 1024 * 1024;
}

function costSharers(opts: { workspaceId: string; costShareWorkspaceIds?: string[] }): string[] {
  return opts.costShareWorkspaceIds?.length ? opts.costShareWorkspaceIds : [opts.workspaceId];
}

/**
 * The scrape body. The adapter injects the warm-signer; tests inject a
 * fake TikTokHttp so the same resolve → extract → normalize path runs
 * without launching Chrome.
 */
export async function runTikTokProxyScrape(
  opts: ScrapeOptions & { platform: string },
  http: TikTokHttp,
): Promise<{ items: ReturnType<typeof normalizeWebItems>; rawCount: number; notices: string[] }> {
  return withTikTokHttp(http, async () => {
    const req = { limit: opts.limit, postedAfter: opts.postedAfter };
    const notices: string[] = [];

    // Embed playlist first (unsigned, works). Impersonated /api/creator/item_list
    // then fills more pages and likes when TLS looks like Chrome.
    const fromEmbed = await fetchEmbedItems(opts.sourceType, opts.query, req);
    let raw = fromEmbed.items;
    notices.push(...fromEmbed.notices);

    if (opts.sourceType === 'creator') {
      const identity = await resolveCreator(opts.query);
      if (identity && identity.secUid && identity.secUid !== 'ssr') {
        const extra = await fetchCreatorPosts(identity, req);
        raw = dedupeItems([...raw, ...extra.items]);
        notices.push(...extra.notices);
      } else if (!raw.length && !identity) {
        return {
          items: [],
          rawCount: 0,
          notices: [`Could not resolve TikTok profile "${opts.query}" — it may not exist, be private, or be region-blocked`],
        };
      }
    } else if (opts.sourceType === 'hashtag') {
      // Always hit the latest item_list. Embed is a popular/evergreen
      // playlist — with a dry limit of 2 it used to fill the page and skip
      // this call, so recency dropped both results as >3 months old.
      const challengeId = await resolveChallengeId(opts.query);
      if (challengeId) {
        const extra = await fetchHashtagPosts(opts.query, challengeId, req);
        raw = dedupeItems([...raw, ...extra.items]);
        notices.push(...extra.notices);
      } else if (!raw.length) {
        return {
          items: [],
          rawCount: 0,
          notices: [`Could not resolve TikTok hashtag "${opts.query}" — it may not exist or has no posts`],
        };
      }
    } else if (opts.sourceType === 'keyword') {
      const asTag = await resolveChallengeId(opts.query);
      if (asTag) {
        const tagged = await fetchHashtagPosts(opts.query, asTag, req);
        raw = dedupeItems([...raw, ...tagged.items]);
        notices.push(...tagged.notices);
      }
      const extra = await fetchSearchPosts(opts.query, req);
      raw = dedupeItems([...raw, ...extra.items]);
      notices.push(...extra.notices);
      if (!raw.length) {
        notices.push(
          `No public TikTok embed playlist for keyword "${opts.query}". `
          + 'Unsigned search is blocked; track the matching hashtag if one exists.',
        );
      }
    }

    raw.sort((a, b) => Number(b.createTime ?? 0) - Number(a.createTime ?? 0));
    if (req.postedAfter) {
      const cutoff = Math.floor(req.postedAfter.getTime() / 1000);
      raw = raw.filter(it => {
        const ts = Number(it.createTime);
        return !Number.isFinite(ts) || ts >= cutoff;
      });
    }
    raw = raw.slice(0, req.limit);

    const hydrateN = Number(process.env.SCRAPER_HYDRATE_STATS ?? 8);
    if (Number.isFinite(hydrateN) && hydrateN > 0) {
      raw = await hydrateItemStats(raw, hydrateN);
    }

    const items = normalizeWebItems(raw);
    return { items, rawCount: raw.length, notices: notices.filter(Boolean) };
  });
}

export const proxyAdapter: ScraperAdapter = {
  name: PROXY_PROVIDER_NAME,

  supports(platform: string): boolean {
    return platform === 'tiktok';
  },

  isConfigured(): boolean {
    return proxyConfig() !== null;
  },

  configurationHint(): string {
    return 'SCRAPER_PROXY_URL is not set. Add it to .env as user:pass@host:port '
      + '(e.g. SCRAPER_PROXY_URL=user:pass@gateway.example.com:8080).';
  },

  async scrape(opts: ScrapeOptions & { platform: string }): Promise<ScrapeResult> {
    if (opts.platform !== 'tiktok') {
      throw new Error(
        `The proxy scraper only supports TikTok (asked for "${opts.platform}"). `
        + 'Set SCRAPER_PROVIDER=apify for other platforms.',
      );
    }
    if (!proxyAdapter.isConfigured()) throw new Error(proxyAdapter.configurationHint());

    // Pre-authorise the WORST case: a cold lookup plus a full page of results.
    // A cap only checked after the fact is not a cap — and unlike money,
    // bandwidth cannot be refunded.
    const needsLookup = opts.sourceType !== 'keyword';
    const estimate = estimateScrapeBytes(opts.limit, needsLookup);
    for (const s of splitSpend(costSharers(opts), estimate)) {
      await assertProxyBudget(s.workspaceId, s.cents);
    }

    const context = `${opts.sourceType}="${opts.query}"`;
    console.log(
      `[proxy] scraping ${context} limit=${opts.limit}`
      + `${opts.postedAfter ? ` postedAfter=${opts.postedAfter.toISOString()}` : ''} `
      + `(est traffic: ${fmtBytes(estimate)})`,
    );

    const before = (await import('./bandwidth.js')).processBytesUsed();
    let bytes = 0;
    try {
      const http = (await createImpersonatedHttp()) ?? unsignedHttp;
      const value = await runTikTokProxyScrape(opts, http);

      bytes = Math.max(0, (await import('./bandwidth.js')).processBytesUsed() - before);
      const items = value.items;
      const costCents = bytesToCents(bytes);

      console.log(
        `[proxy] ${context} -> ${items.length}/${value.rawCount} usable videos, `
        + `${fmtBytes(bytes)} traffic (~${costCents}c)`,
      );

      return {
        items,
        costCents,
        rawCount: value.rawCount,
        // No provider-side storage: there is nothing to resume, and saying so
        // honestly is better than handing back a receipt that cannot be redeemed.
        actorRunId: null,
        datasetId: null,
        resumed: false,
        notices: value.notices,
        provider: PROXY_PROVIDER_NAME,
        bytesUsed: bytes,
      };
    } catch (err) {
      bytes = Math.max(0, (await import('./bandwidth.js')).processBytesUsed() - before);
      throw err;
    } finally {
      // Record what actually moved, even if the scrape threw after some
      // pages landed — those bytes were billed and must not vanish.
      if (bytes > 0) {
        try {
          for (const s of splitSpend(costSharers(opts), bytes)) {
            await recordTrafficBytes(s.workspaceId, s.cents, opts.refId ?? null);
          }
        } catch (err) {
          console.warn(`[proxy] failed to record ${fmtBytes(bytes)}: ${(err as Error).message}`);
        }
      }
    }
  },

  async downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
    if (!proxyAdapter.isConfigured()) throw new Error(proxyAdapter.configurationHint());
    if (!opts.workspaceId) throw new Error('workspaceId is required (needed for traffic accounting).');

    const itemId = extractVideoId(opts.videoUrl);
    if (!itemId) throw new Error(`Could not read a video id out of "${opts.videoUrl}"`);

    // A whole video is the single most expensive thing this adapter can do,
    // so it is pre-authorised at the ceiling rather than at a hopeful average.
    await assertProxyBudget(opts.workspaceId, maxVideoBytes());

    const http = (await createImpersonatedHttp()) ?? unsignedHttp;
    const video = await resolvePlayableVideo(opts.videoUrl, itemId, http);

    const variants = listPlayableVariants(video);
    if (!variants.length) throw new Error('TikTok returned no playable URL for this video');

    const ceiling = maxVideoBytes();
    const handle = extractHandle(opts.videoUrl);
    const watchUrl = handle
      ? `https://www.tiktok.com/@${handle}/video/${itemId}`
      : opts.videoUrl;

    const { pick, buffer } = await downloadFirstWorking(variants, watchUrl, ceiling, http);

    if (buffer.length < 1024) {
      throw new Error(`Downloaded file too small (${buffer.length} bytes) — likely an error page`);
    }
    writeFileSync(opts.outputPath, buffer);

    const costCents = await recordTrafficBytes(opts.workspaceId, buffer.length, opts.videoUrl);

    return {
      costCents,
      sizeBytes: buffer.length,
      cdnUrl: pick.url,
      actorRunId: null,
      provider: PROXY_PROVIDER_NAME,
      bytesUsed: buffer.length,
    };
  },
};

/** `.../video/1234567890` or `/v/1234.html` — the id is the long digit run. */
export function extractVideoId(url: string): string | null {
  const m = url.match(/\/(?:video|v|photo)\/(\d{6,})/) ?? url.match(/(\d{15,})/);
  return m?.[1] ?? null;
}

/** `@handle` from a watch URL. Null when the caller only has a raw id. */
export function extractHandle(url: string): string | null {
  const m = url.match(/tiktok\.com\/@([^/?#]+)\/(?:video|photo|v)\//i);
  if (!m?.[1]) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Resolve the playable `video` object. `/api/item/detail` is a dead 200/0B
 * even under Chrome TLS (2026-08-14), so this uses the watch-page blob —
 * the same source hydrateItemStats already trusts.
 */
export async function resolvePlayableVideo(
  videoUrl: string,
  itemId: string,
  http: TikTokHttp,
): Promise<any> {
  const getter = http.getText;
  if (!getter) throw new Error('TikTok HTTP client cannot fetch HTML');

  const handle = extractHandle(videoUrl);
  const pageUrl = handle
    ? `https://www.tiktok.com/@${encodeURIComponent(handle)}/video/${itemId}`
    : `https://www.tiktok.com/embed/v2/${itemId}`;
  const referer = handle ? `https://www.tiktok.com/@${handle}` : 'https://www.tiktok.com/';

  const page = await getter(pageUrl, {
    Accept: 'text/html,application/xhtml+xml',
    Referer: referer,
  });
  const struct = page.ok ? itemStructFromWatchHtml(page.text) : null;
  if (struct?.imagePost) {
    throw new SlideshowPostError(extractSlideshowImages(struct));
  }
  const video = struct?.video && typeof struct.video === 'object' ? struct.video : null;
  if (video && listPlayableVariants(video).length > 0) return video;

  const rehydrate = Boolean(page.text?.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__'));
  throw new Error(
    video
      ? 'TikTok returned no playable URL for this video'
      : `TikTok watch page had no playable video (http=${page.status}, rehydrate=${rehydrate}) `
        + '— the post may be deleted, private, or region-blocked',
  );
}

export interface VideoVariant {
  url: string;
  declaredBytes: number | null;
  label: string;
}

/**
 * Choose the cheapest usable rendition.
 *
 * TikTok publishes a bitrate ladder in `bitrateInfo`, each rung carrying its
 * own DataSize. The rungs commonly span 3-5x, and nothing downstream — Gemini
 * analysis, an inline gallery player — benefits from the top one. Picking the
 * smallest turns a 6MB download into ~1.5MB for identical usefulness, which on
 * a per-GB plan is a 4x increase in how many videos the plan buys.
 */
export function listPlayableVariants(video: any): VideoVariant[] {
  const ladder: VideoVariant[] = [];
  const seen = new Set<string>();
  const push = (v: VideoVariant) => {
    if (seen.has(v.url)) return;
    seen.add(v.url);
    ladder.push(v);
  };

  const bitrateInfo = [
    ...(Array.isArray(video?.bitrateInfo) ? video.bitrateInfo : []),
    ...(Array.isArray(video?.bitRate) ? video.bitRate : []),
  ];
  for (const rung of bitrateInfo) {
    const url = firstUrl(rung?.PlayAddr ?? rung?.playAddr ?? rung?.play_addr);
    if (!url) continue;
    const size = Number(rung?.PlayAddr?.DataSize ?? rung?.playAddr?.DataSize ?? rung?.DataSize ?? rung?.dataSize);
    push({
      url,
      declaredBytes: Number.isFinite(size) && size > 0 ? size : null,
      label: `${rung?.GearName ?? rung?.gearName ?? 'variant'}`,
    });
  }

  const fallback = firstUrl(video?.playAddr)
    ?? firstUrl(video?.PlayAddr)
    ?? firstUrl(video?.downloadAddr)
    ?? firstUrl(video?.DownloadAddr);
  if (fallback) push({ url: fallback, declaredBytes: null, label: 'playAddr' });

  return ladder.sort((a, b) => {
    if (a.declaredBytes != null && b.declaredBytes != null) return a.declaredBytes - b.declaredBytes;
    if (a.declaredBytes != null) return -1;
    if (b.declaredBytes != null) return 1;
    return 0;
  });
}

export function pickSmallestVariant(video: any): VideoVariant | null {
  return listPlayableVariants(video)[0] ?? null;
}

function firstUrl(v: unknown): string | null {
  if (typeof v === 'string') return v.startsWith('http') ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrl(x);
      if (u) return u;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return firstUrl(o.UrlList ?? o.urlList ?? o.Url ?? o.url);
  }
  return null;
}

async function downloadBinary(
  url: string,
  referer: string,
  maxBytes: number,
  http: TikTokHttp,
): Promise<Buffer> {
  const headers = {
    Referer: referer,
    Origin: 'https://www.tiktok.com',
    Accept: 'video/mp4,video/*,*/*',
  };
  const getter = http.getBuffer;
  if (!getter) throw new Error('TikTok HTTP client cannot fetch binary');

  const result = await getter(url, headers, maxBytes);
  if (!result.ok && result.status !== 206) {
    throw new Error(
      `TikTok CDN download failed (${result.status}) via proxy: ${result.buffer.toString('utf8').slice(0, 200)}`,
    );
  }
  if (result.buffer.length > maxBytes) {
    throw new Error(
      `Video exceeded the ${fmtBytes(maxBytes)} SCRAPER_PROXY_MAX_VIDEO_MB ceiling — download stopped`,
    );
  }
  return result.buffer;
}

async function downloadFirstWorking(
  variants: VideoVariant[],
  referer: string,
  maxBytes: number,
  http: TikTokHttp,
): Promise<{ pick: VideoVariant; buffer: Buffer }> {
  let lastErr: Error | null = null;
  for (const pick of variants) {
    if (pick.declaredBytes && pick.declaredBytes > maxBytes) {
      lastErr = new Error(
        `Video is ${fmtBytes(pick.declaredBytes)}, above the ${fmtBytes(maxBytes)} `
        + 'SCRAPER_PROXY_MAX_VIDEO_MB ceiling — refusing to spend the traffic',
      );
      continue;
    }
    console.log(
      `[proxy] downloading via ${pick.label}`
      + `${pick.declaredBytes ? ` (~${fmtBytes(pick.declaredBytes)})` : ''}`,
    );
    try {
      const buffer = await downloadBinary(pick.url, referer, maxBytes, http);
      return { pick, buffer };
    } catch (err) {
      lastErr = err as Error;
      if (!/CDN download failed \(403\)/.test(lastErr.message)) throw lastErr;
      console.warn(`[proxy] ${pick.label} 403, trying next variant`);
    }
  }
  throw lastErr ?? new Error('TikTok returned no playable URL for this video');
}
