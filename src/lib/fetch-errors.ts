// ---------------------------------------------------------------------------
// Fetch-error classification — turn a failed video-fetch job's stored
// lastError into a code + message the gallery can render as an error icon.
//
// The fetch path (kind='fetch' MediaJob -> downloadTikTokVideo) has a handful
// of distinct, actionable failure modes, several Apify-specific:
//
//   apify_spend_cap    — the monthly Apify cap (APIFY_SPEND_CAP_CENTS) is hit
//   apify_no_key       — APIFY_API_KEY missing/unset
//   video_not_found    — the TikTok actor returned no items for the URL
//   video_unavailable  — deleted/restricted, no CDN URL in the actor response
//   apify_cdn_failed   — the TikTok CDN refused the download
//   apify_actor_error  — the Apify actor run itself failed
//   download_failed    — downloaded bytes were too small to be a real video
//   other              — anything else (raw message preserved for tooltips)
//
// Provider-neutral codes (proxy worker and anything after it):
//
//   scraper_spend_cap       — the active provider's monthly cap (proxy traffic
//                             GB, or Apify cents) is hit
//   scraper_not_configured  — SCRAPER_PROXY_URL missing/unset
//   scraper_cdn_failed      — the TikTok CDN refused a download made via proxy
//   video_too_large         — video above SCRAPER_PROXY_MAX_VIDEO_MB; the same
//                             bytes fail every retry, so it is never requeued
//
// The apify_* codes are STORED in old rows and still emitted for Apify-origin
// messages, so they stay in FetchErrorCode. LEGACY_ERROR_CODE_ALIASES maps each
// one (plus the old HTTP error strings) to its neutral name; stored rows are
// never rewritten.
//
// The gallery card carries the newest failure per video so the UI can show
// "couldn't scrape this video because X" instead of a silent blank thumbnail.
// ---------------------------------------------------------------------------

export type FetchErrorCode =
  | 'apify_spend_cap'
  | 'apify_no_key'
  | 'video_not_found'
  | 'video_unavailable'
  | 'apify_cdn_failed'
  | 'apify_not_stored'
  | 'apify_actor_error'
  | 'download_failed'
  | 'openrouter_balance'
  | 'scraper_spend_cap'
  | 'scraper_not_configured'
  | 'scraper_cdn_failed'
  | 'video_too_large'
  | 'other';

/**
 * Old Apify-named error strings (stored fetch-error codes and HTTP error
 * bodies) -> their provider-neutral name. Lookup only: nothing in storage is
 * rewritten, and the old strings keep being accepted and emitted.
 */
export const LEGACY_ERROR_CODE_ALIASES: Readonly<Record<string, string>> = {
  apify_spend_cap: 'scraper_spend_cap',
  apify_no_key: 'scraper_not_configured',
  apify_cdn_failed: 'scraper_cdn_failed',
  apify_not_stored: 'scraper_video_not_stored',
  apify_actor_error: 'scraper_error',
  apify_spend_cap_breached: 'scraper_spend_cap_breached',
  apify_spend_cap_exceeded: 'scraper_spend_cap_exceeded',
};

/** The provider-neutral name for any error code; unknown codes pass through. */
export function canonicalErrorCode(code: string): string {
  return LEGACY_ERROR_CODE_ALIASES[code] ?? code;
}

export interface FetchErrorInfo {
  code: FetchErrorCode;
  /** Short, human explanation for a tooltip / card note. */
  message: string;
}

/** Classify a persisted fetch-job lastError. Null when there is nothing to show. */
export function classifyFetchError(lastError: string | null): FetchErrorInfo | null {
  if (!lastError?.trim()) return null;
  const msg = lastError;

  // Order matters: check the specific, actionable messages before the generic
  // actor failure (several start with "Apify ...").
  if (/proxy traffic cap/i.test(msg)) {
    return { code: 'scraper_spend_cap', message: 'Proxy traffic cap reached — scraping is paused. Raise PROXY_TRAFFIC_CAP_GB or wait for next month.' };
  }
  if (/spend cap/i.test(msg)) {
    return { code: 'apify_spend_cap', message: 'Apify monthly spend cap reached — scraping is paused. Raise the cap or wait for next month.' };
  }
  if (/apify_api_key is not set/i.test(msg)) {
    return { code: 'apify_no_key', message: 'APIFY_API_KEY is missing on the server — configure it to scrape.' };
  }
  if (/scraper_proxy_url is not set/i.test(msg)) {
    return { code: 'scraper_not_configured', message: 'SCRAPER_PROXY_URL is missing on the server — configure it to scrape.' };
  }
  if (/SCRAPER_PROXY_MAX_VIDEO_MB ceiling/.test(msg)) {
    return { code: 'video_too_large', message: 'Video is larger than the proxy download ceiling (SCRAPER_PROXY_MAX_VIDEO_MB) — skipped to protect the traffic budget.' };
  }
  if (/returned no items/i.test(msg) || /watch page had no playable video/i.test(msg) || /returned no video detail/i.test(msg)) {
    return { code: 'video_not_found', message: 'TikTok could not find this video by URL (deleted or unavailable).' };
  }
  if (/photo\/slideshow/i.test(msg)) {
    return { code: 'video_unavailable', message: 'This TikTok is a photo slideshow, not a video — nothing to download.' };
  }
  if (/no playable url/i.test(msg) || /no video cdn url/i.test(msg)) {
    return { code: 'video_unavailable', message: 'No downloadable video file (deleted, restricted, or region-locked).' };
  }
  if (/did not store the video|only a tiktok cdn url/i.test(msg)) {
    return { code: 'apify_not_stored', message: 'The scrape actor did not save the video to Apify storage (only a TikTok CDN URL — blocked from servers). Text fallback was used.' };
  }
  if (/cdn download failed[^:]*via proxy/i.test(msg)) {
    return { code: 'scraper_cdn_failed', message: 'TikTok CDN refused the download via the proxy.' };
  }
  if (/tik tok cdn download failed|cdn download failed/i.test(msg)) {
    return { code: 'apify_cdn_failed', message: 'TikTok CDN refused the download.' };
  }
  // OpenRouter rejects video-format requests below a $1.00 account balance.
  if (/requires at least \$\d/.test(msg) || (/\bbalance for video\b/i.test(msg))) {
    return { code: 'openrouter_balance', message: 'OpenRouter needs at least $1.00 balance for video analysis — top up at openrouter.ai/settings/credits.' };
  }
  if (/apify actor/i.test(msg)) {
    return { code: 'apify_actor_error', message: 'The Apify scrape actor failed to run.' };
  }
  if (/too small/i.test(msg)) {
    return { code: 'download_failed', message: 'Downloaded file was empty/an error page.' };
  }
  return { code: 'other', message: msg.slice(0, 160) };
}
