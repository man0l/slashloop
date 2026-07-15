// ---------------------------------------------------------------------------
// Apify client — minimal TikTok scraper integration.
//
// Uses the apify/tiktok-scraper actor in sync mode (run-sync-get-dataset-items).
// This is the simplest invocation: POST with the search query, block until
// results are ready, return the dataset items.
//
// Cost: roughly $0.30 per 1000 results on the apify/tiktok-scraper actor.
// All calls are subject to the spend cap in lib/spend-cap.ts.
//
// For Reels and Shorts we fall back to the same experimental stub — Reels
// needs a different actor (apify/instagram-scraper) and Shorts needs the
// YouTube Data API. Both are TODO; the cap is enforced whenever we wire them.
// ---------------------------------------------------------------------------

import { assertApifyCap, recordApifySpend } from './spend-cap.js';
import { normalizeTikTok, type NormalizedVideo } from '../normalizers.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const TIKTOK_ACTOR_ID = 'apify~tiktok-scraper';

// Estimated cost per result, in cents. apify/tiktok-scraper averages ~$0.0003
// per result on the searchPosts endpoint. We pre-authorize this before each
// call so the cap check is conservative.
const ESTIMATED_COST_PER_RESULT_CENTS = 0.04; // ~$0.0004, slight pad

export interface ApifyScrapeOptions {
  workspaceId: string;
  sourceType: 'creator' | 'keyword' | 'hashtag';
  query: string; // handle, keyword phrase, or hashtag (with or without #)
  limit: number; // max results
}

export interface ApifyScrapeResult {
  items: NormalizedVideo[];
  costCents: number; // actual cost charged (estimate for now)
  rawCount: number;
  actorRunId: string | null;
}

// ---------------------------------------------------------------------------
// TikTok scraper — calls apify/tiktok-scraper
// ---------------------------------------------------------------------------

export async function scrapeTikTok(opts: ApifyScrapeOptions): Promise<ApifyScrapeResult> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error('APIFY_API_KEY is not set. Add it to .env (or the MCP server env block in your client config).');

  // Pre-authorize cost
  const estimatedCostCents = Math.ceil(opts.limit * ESTIMATED_COST_PER_RESULT_CENTS);
  await assertApifyCap(opts.workspaceId, estimatedCostCents);

  // Build the actor input. apify/tiktok-scraper accepts:
  //   - searchQueries: array of hashtags (without #) or keywords
  //   - resultsPerPage: integer
  //   - profiles: array of usernames (for sourceType=creator)
  // See https://apify.com/apify/tiktok-scraper/input-schema
  const hashtags = opts.query.replace(/^#/, '').trim();
  const input: Record<string, unknown> = {
    resultsPerPage: opts.limit,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadSubtitles: false,
  };

  if (opts.sourceType === 'creator') {
    input.profiles = [opts.query.replace(/^@/, '').trim()];
  } else if (opts.sourceType === 'hashtag') {
    input.searchQueries = [hashtags];
    input.isHashTag = true;
  } else {
    // keyword
    input.searchQueries = [opts.query.trim()];
    input.isHashTag = false;
  }

  const url = `${APIFY_API_BASE}/acts/${TIKTOK_ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}`;
  console.log(`[apify] calling TikTok scraper for ${opts.sourceType}="${opts.query}" limit=${opts.limit} (est cost: ${estimatedCostCents}c)`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify TikTok scraper failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const rawItems = (await res.json()) as any[];
  if (!Array.isArray(rawItems)) {
    throw new Error(`Apify returned non-array response: ${JSON.stringify(rawItems).slice(0, 200)}`);
  }

  // Normalize via the existing normalizer
  const items: NormalizedVideo[] = rawItems
    .map(raw => {
      try {
        return normalizeTikTok(raw);
      } catch {
        return null;
      }
    })
    .filter((v): v is NormalizedVideo => v !== null && !!v.externalId);

  // Record actual cost (we use the estimate since Apify's per-call billing
  // is not returned in the response — the real invoice lands later).
  await recordApifySpend(opts.workspaceId, estimatedCostCents, null);

  return {
    items,
    costCents: estimatedCostCents,
    rawCount: rawItems.length,
    actorRunId: null,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — picks the right scraper per platform. Currently only TikTok
// is wired up; Reels and Shorts return a clear error.
// ---------------------------------------------------------------------------

export async function scrapeSource(opts: ApifyScrapeOptions & { platform: string }): Promise<ApifyScrapeResult> {
  switch (opts.platform) {
    case 'tiktok':
      return scrapeTikTok(opts);
    case 'reels':
      throw new Error('Instagram Reels scraper not yet implemented (would use apify/instagram-scraper). Spend cap will be enforced when wired.');
    case 'shorts':
      throw new Error('YouTube Shorts scraper not yet implemented (would use YOUTUBE_API_KEY). Spend cap will be enforced when wired.');
    default:
      throw new Error(`Unknown platform: ${opts.platform}`);
  }
}
