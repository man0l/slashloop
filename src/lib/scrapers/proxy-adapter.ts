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
//   4. A single-video download resolves through one ~20KB detail call rather
//      than re-rendering the watch page.
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import {
  bytesToCents, fmtBytes, recordTrafficBytes,
} from './bandwidth.js';
import { assertProxyBudget } from './budget.js';
import { proxyConfig, proxyFetchBuffer, proxyFetchJson } from './proxy-http.js';
import { createImpersonatedHttp } from './impersonate-http.js';
import {
  dedupeItems, estimateScrapeBytes, fetchCreatorPosts, fetchEmbedItems,
  fetchHashtagPosts, fetchSearchPosts, hydrateItemStats, normalizeWebItems,
  resolveChallengeId, resolveCreator, unsignedHttp, withTikTokHttp,
  type TikTokHttp,
} from './tiktok-web.js';
import { splitSpend } from '../apify.js';
import type { DownloadOptions, DownloadResult, ScrapeOptions, ScrapeResult, ScraperAdapter } from './types.js';

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
    } else if (opts.sourceType === 'hashtag' && raw.length < req.limit) {
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
    } else if (opts.sourceType === 'keyword' && raw.length < req.limit) {
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

    const { json } = await proxyFetchJson<any>(
      `https://www.tiktok.com/api/item/detail/?itemId=${encodeURIComponent(itemId)}&aid=1988`,
      { maxBytes: 256 * 1024, headers: { Referer: opts.videoUrl } },
    );
    const video = json?.itemInfo?.itemStruct?.video;
    if (!video) {
      throw new Error('TikTok returned no video detail — the post may be deleted, private, or region-blocked');
    }

    const pick = pickSmallestVariant(video);
    if (!pick) throw new Error('TikTok returned no playable URL for this video');

    console.log(
      `[proxy] downloading ${itemId} via ${pick.label}`
      + `${pick.declaredBytes ? ` (~${fmtBytes(pick.declaredBytes)})` : ''}`,
    );
    if (pick.declaredBytes && pick.declaredBytes > maxVideoBytes()) {
      throw new Error(
        `Video is ${fmtBytes(pick.declaredBytes)}, above the ${fmtBytes(maxVideoBytes())} `
        + 'SCRAPER_PROXY_MAX_VIDEO_MB ceiling — refusing to spend the traffic',
      );
    }

    // Binary, so it goes through proxyFetch's stream cap rather than the JSON
    // helper. Residential exit is mandatory here: TikTok's CDN 403s datacenter
    // IPs, which is the whole reason the Apify path had to buy an actor run.
    const buffer = await downloadBinary(pick.url, maxVideoBytes());

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
export function pickSmallestVariant(video: any): VideoVariant | null {
  const ladder: VideoVariant[] = [];
  const bitrateInfo = Array.isArray(video?.bitrateInfo) ? video.bitrateInfo : [];
  for (const rung of bitrateInfo) {
    const url = firstUrl(rung?.PlayAddr?.UrlList ?? rung?.playAddr?.urlList);
    if (!url) continue;
    const size = Number(rung?.PlayAddr?.DataSize ?? rung?.DataSize ?? rung?.dataSize);
    ladder.push({
      url,
      declaredBytes: Number.isFinite(size) && size > 0 ? size : null,
      label: `${rung?.GearName ?? rung?.gearName ?? 'variant'}`,
    });
  }

  const sized = ladder.filter(v => v.declaredBytes != null);
  if (sized.length > 0) {
    return sized.reduce((a, b) => (a.declaredBytes! <= b.declaredBytes! ? a : b));
  }
  if (ladder.length > 0) return ladder[0]!;

  // No ladder published — fall back to the single playable URL.
  const fallback = firstUrl(video?.playAddr) ?? firstUrl(video?.downloadAddr);
  return fallback ? { url: fallback, declaredBytes: null, label: 'playAddr' } : null;
}

function firstUrl(v: unknown): string | null {
  if (typeof v === 'string' && v.startsWith('http')) return v;
  if (Array.isArray(v)) {
    for (const x of v) if (typeof x === 'string' && x.startsWith('http')) return x;
  }
  return null;
}

async function downloadBinary(url: string, maxBytes: number): Promise<Buffer> {
  const result = await proxyFetchBuffer(url, {
    maxBytes,
    compress: false,
    headers: {
      Referer: 'https://www.tiktok.com/',
      Accept: '*/*',
      // Cap the transfer at the source when the CDN honours Range, so we
      // never pull a 40MB original just to throw it away.
      Range: `bytes=0-${maxBytes - 1}`,
    },
  });
  if (!result.ok && result.status !== 206) {
    throw new Error(
      `TikTok CDN download failed (${result.status}) via proxy: ${result.buffer.toString('utf8').slice(0, 200)}`,
    );
  }
  if (result.truncated || result.buffer.length > maxBytes) {
    throw new Error(
      `Video exceeded the ${fmtBytes(maxBytes)} SCRAPER_PROXY_MAX_VIDEO_MB ceiling — download stopped`,
    );
  }
  return result.buffer;
}
