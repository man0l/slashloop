// ---------------------------------------------------------------------------
// Apify adapter — the default, production-proven provider.
//
// A thin conformance shim, on purpose. All the behaviour (actor fallback,
// dataset receipts, PPE cost modelling, spend cap) already lives in
// ../apify.ts and is unchanged by the introduction of the adapter layer, so
// switching providers cannot regress the path that has been running.
// ---------------------------------------------------------------------------

import { scrapeSource as apifyScrapeSource, downloadTikTokVideo } from '../apify.js';
import type { DownloadOptions, DownloadResult, ScrapeOptions, ScrapeResult, ScraperAdapter } from './types.js';

export const APIFY_PROVIDER = 'apify';

export const apifyAdapter: ScraperAdapter = {
  name: APIFY_PROVIDER,

  supports(platform: string): boolean {
    // reels/shorts have no actor wired up; apify.ts throws a clear error for
    // them and that error is more useful than a generic "unsupported".
    return platform === 'tiktok' || platform === 'reels' || platform === 'shorts';
  },

  isConfigured(): boolean {
    return !!process.env.APIFY_API_KEY?.trim();
  },

  configurationHint(): string {
    return 'APIFY_API_KEY is not set. Add it to .env (or the MCP server env block in your client config).';
  },

  async scrape(opts: ScrapeOptions & { platform: string }): Promise<ScrapeResult> {
    const result = await apifyScrapeSource(opts as any);
    return { ...result, provider: APIFY_PROVIDER };
  },

  async downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
    const result = await downloadTikTokVideo(opts);
    return { ...result, provider: APIFY_PROVIDER };
  },
};
