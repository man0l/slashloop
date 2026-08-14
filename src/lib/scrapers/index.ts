// ---------------------------------------------------------------------------
// Scraper registry — the one place that decides WHO scrapes.
//
//   SCRAPER_PROVIDER=apify   (default) — Apify actors, billed per result
//   SCRAPER_PROVIDER=proxy             — direct TikTok, billed per gigabyte
//
// Exclusive. There is no fallback from one provider to the other: a proxy
// miss that silently bills Apify is a surprise invoice, and the reverse
// hides a misconfigured SCRAPER_PROXY_URL for months.
//
// Single-video MP4s (fetch / analyze) are the case the residential proxy
// exists for — TikTok's CDN 403s datacenter IPs, so Apify was only buying
// a KV-stored binary at ~1c/video. When SCRAPER_PROXY_URL is set, downloads
// go through proxy and only proxy. List scrapes still follow SCRAPER_PROVIDER.
// ---------------------------------------------------------------------------

import { apifyAdapter, APIFY_PROVIDER } from './apify-adapter.js';
import { proxyAdapter, PROXY_PROVIDER_NAME } from './proxy-adapter.js';
import {
  ScraperUnavailableError,
  type DownloadOptions, type DownloadResult, type ScrapeOptions, type ScrapeResult, type ScraperAdapter,
} from './types.js';

export * from './types.js';
export { apifyAdapter, proxyAdapter };
export { estimateScrapeBytes, extractSlideshowImages, slideshowImagesFromRaw, slideshowKeysFromRaw } from './tiktok-web.js';
export { assertTrafficCap, trafficStatus, TrafficCapExceededError, wouldExceedCap } from './bandwidth.js';
export { proxyCheapBandwidth, formatProxyCheap, parseProxiesResponse, bandwidthFromProxyRecord } from './proxy-cheap.js';
export { remainingBudgetBytes, vendorRemainingBytes, assertProxyBudget } from './budget.js';
export { closeWarmSigner, scrapeTikTokInBrowser } from './warm-signer.js';

export const DEFAULT_PROVIDER = APIFY_PROVIDER;

const REGISTRY = new Map<string, ScraperAdapter>([
  [APIFY_PROVIDER, apifyAdapter],
  [PROXY_PROVIDER_NAME, proxyAdapter],
]);

/** Register an adapter at runtime (tests, and future providers). */
export function registerScraper(adapter: ScraperAdapter): void {
  REGISTRY.set(adapter.name, adapter);
}

export function listScrapers(): string[] {
  return [...REGISTRY.keys()];
}

/** Alias table so a provider can be named the way people actually write it. */
const ALIASES: Record<string, string> = {
  '': APIFY_PROVIDER,
  default: APIFY_PROVIDER,
  residential: PROXY_PROVIDER_NAME,
  'proxy-cheap': PROXY_PROVIDER_NAME,
  proxycheap: PROXY_PROVIDER_NAME,
  direct: PROXY_PROVIDER_NAME,
  'tiktok-web': PROXY_PROVIDER_NAME,
};

export function resolveProviderName(raw?: string): string {
  const key = (raw ?? process.env.SCRAPER_PROVIDER ?? '').trim().toLowerCase();
  return ALIASES[key] ?? key ?? DEFAULT_PROVIDER;
}

/**
 * The adapter to use. Unknown names FAIL rather than falling back to the
 * default: a typo'd SCRAPER_PROVIDER that silently keeps billing Apify is a
 * config bug that hides for months.
 */
export function getScraper(name?: string): ScraperAdapter {
  const resolved = resolveProviderName(name);
  const adapter = REGISTRY.get(resolved);
  if (!adapter) {
    throw new ScraperUnavailableError(
      resolved,
      `unknown provider. Set SCRAPER_PROVIDER to one of: ${listScrapers().join(', ')}`,
    );
  }
  return adapter;
}

/** The named adapter, or throw. Never substitutes the other provider. */
function requireAdapter(platform: string, name?: string): ScraperAdapter {
  const adapter = getScraper(name);
  if (!adapter.supports(platform)) {
    throw new ScraperUnavailableError(adapter.name, `it does not support platform "${platform}"`);
  }
  if (!adapter.isConfigured()) {
    throw new ScraperUnavailableError(adapter.name, adapter.configurationHint());
  }
  return adapter;
}

/**
 * Single-video download adapter.
 *
 * Proxy when SCRAPER_PROXY_URL is set (TikTok CDN needs a residential exit).
 * Otherwise the exclusive SCRAPER_PROVIDER. An explicit `name` wins, so
 * tests can still force Apify.
 */
export function selectDownloadAdapter(platform = 'tiktok', name?: string): ScraperAdapter {
  if (name?.trim()) return requireAdapter(platform, name);

  const proxy = REGISTRY.get(PROXY_PROVIDER_NAME);
  if (platform === 'tiktok' && proxy?.isConfigured()) return proxy;

  return requireAdapter(platform);
}

// ---------------------------------------------------------------------------
// Facade — what the rest of the codebase calls.
// ---------------------------------------------------------------------------

export async function scrapeSource(
  opts: ScrapeOptions & { platform: string; provider?: string },
): Promise<ScrapeResult> {
  const adapter = requireAdapter(opts.platform, opts.provider);
  return adapter.scrape(opts);
}

export async function downloadVideo(
  opts: DownloadOptions & { platform?: string; provider?: string },
): Promise<DownloadResult> {
  const adapter = selectDownloadAdapter(opts.platform ?? 'tiktok', opts.provider);
  return adapter.downloadVideo(opts);
}

/** Which provider a given platform would use right now — for status output. */
export function activeProviderFor(platform = 'tiktok'): string {
  try {
    return requireAdapter(platform).name;
  } catch {
    return resolveProviderName();
  }
}

/** Which spend/traffic ledger governs a scrape of this platform right now. */
export function scrapeCapKind(platform = 'tiktok'): 'apify' | 'proxy' {
  return activeProviderFor(platform) === PROXY_PROVIDER_NAME ? 'proxy' : 'apify';
}
