// ---------------------------------------------------------------------------
// Scraper registry — the one place that decides WHO scrapes.
//
//   SCRAPER_PROVIDER=apify   (default) — Apify actors, billed per result
//   SCRAPER_PROVIDER=proxy             — direct TikTok, billed per gigabyte
//
// Callers import `scrapeSource` / `downloadVideo` from here and never name a
// vendor. The default is `apify` deliberately: it is the path with production
// mileage, so an unset env var keeps existing deployments byte-for-byte on the
// behaviour they already have.
//
// SCRAPER_FALLBACK_PROVIDER (optional) names a provider to retry with when the
// primary is unconfigured or fails outright. It is OFF by default, because a
// silent fallback from a per-GB provider to a per-result one is a surprise
// invoice — it should be opted into, not inherited.
// ---------------------------------------------------------------------------

import { apifyAdapter, APIFY_PROVIDER } from './apify-adapter.js';
import { proxyAdapter, PROXY_PROVIDER_NAME } from './proxy-adapter.js';
import {
  ScraperUnavailableError,
  type DownloadOptions, type DownloadResult, type ScrapeOptions, type ScrapeResult, type ScraperAdapter,
} from './types.js';

export * from './types.js';
export { apifyAdapter, proxyAdapter };
export { estimateScrapeBytes } from './tiktok-web.js';
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

function fallbackAdapter(primary: ScraperAdapter): ScraperAdapter | null {
  const raw = process.env.SCRAPER_FALLBACK_PROVIDER?.trim();
  if (!raw) return null;
  const name = resolveProviderName(raw);
  if (name === primary.name) return null;
  const adapter = REGISTRY.get(name);
  return adapter && adapter.isConfigured() ? adapter : null;
}

/** Pick the adapter that can actually serve this platform, right now. */
function selectFor(platform: string, name?: string): ScraperAdapter {
  const primary = getScraper(name);
  if (primary.supports(platform) && primary.isConfigured()) return primary;

  const fallback = fallbackAdapter(primary);
  if (fallback && fallback.supports(platform)) {
    console.warn(
      `[scrapers] ${primary.name} cannot serve ${platform} `
      + `(${primary.supports(platform) ? 'not configured' : 'unsupported platform'}) — `
      + `falling back to ${fallback.name}`,
    );
    return fallback;
  }

  if (!primary.supports(platform)) {
    throw new ScraperUnavailableError(primary.name, `it does not support platform "${platform}"`);
  }
  throw new ScraperUnavailableError(primary.name, primary.configurationHint());
}

// ---------------------------------------------------------------------------
// Facade — what the rest of the codebase calls.
// ---------------------------------------------------------------------------

export async function scrapeSource(
  opts: ScrapeOptions & { platform: string; provider?: string },
): Promise<ScrapeResult> {
  const adapter = selectFor(opts.platform, opts.provider);
  return adapter.scrape(opts);
}

export async function downloadVideo(
  opts: DownloadOptions & { platform?: string; provider?: string },
): Promise<DownloadResult> {
  const adapter = selectFor(opts.platform ?? 'tiktok', opts.provider);
  return adapter.downloadVideo(opts);
}

/** Which provider a given platform would use right now — for status output. */
export function activeProviderFor(platform = 'tiktok'): string {
  try {
    return selectFor(platform).name;
  } catch {
    return resolveProviderName();
  }
}

/** Which spend/traffic ledger governs a scrape of this platform right now. */
export function scrapeCapKind(platform = 'tiktok'): 'apify' | 'proxy' {
  return activeProviderFor(platform) === PROXY_PROVIDER_NAME ? 'proxy' : 'apify';
}
