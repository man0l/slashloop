// ---------------------------------------------------------------------------
// Apify client — minimal TikTok scraper integration.
//
// Uses a TikTok scraper actor in sync mode (run-sync-get-dataset-items).
// This is the simplest invocation: POST with the search query, block until
// results are ready, return the dataset items.
//
// Cost: PAY_PER_EVENT pricing — $0.0005-$0.0037 per result depending on the
// calling account's usage tier, plus a flat $0.001 per actor run. We don't
// know the account's tier from here, so we pre-authorize using the FREE-tier
// (most expensive) rate to keep the cap check conservative rather than risk
// under-authorizing. All calls are subject to the spend cap in lib/spend-cap.ts.
//
// For Reels and Shorts we fall back to the same experimental stub — Reels
// needs a different actor (apify/instagram-scraper) and Shorts needs the
// YouTube Data API. Both are TODO; the cap is enforced whenever we wire them.
//
// --- Actor selection & fallback ---
// clockworks/tiktok-scraper is the production-proven default. Set
// APIFY_TIKTOK_ACTOR_ID to try a different actor (e.g. a personal fork) as
// the PRIMARY one instead, without a code change or redeploy of this file.
// Every call still falls back to clockworks automatically if the configured
// primary actor's run fails — clockworks itself has no further fallback, so
// a failure there is a real, terminal failure. A primary-actor failure logs
// under the `[apify:actor-fallback]` tag specifically (not raised for
// clockworks failures) so it's easy to grep for in Vercel logs without
// wading through normal, expected scrape noise.
// ---------------------------------------------------------------------------

import { assertApifyCap, recordApifySpend } from './spend-cap.js';
import { normalizeTikTok, type NormalizedVideo } from '../normalizers.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const DEFAULT_TIKTOK_ACTOR_ID = 'clockworks~tiktok-scraper';

/** The actor to try first. Defaults to the production-proven clockworks actor. */
export function primaryTikTokActorId(): string {
  return process.env.APIFY_TIKTOK_ACTOR_ID?.trim() || DEFAULT_TIKTOK_ACTOR_ID;
}

// ---------------------------------------------------------------------------
// Video-binary URL resolution — which URL to HTTP-GET for the actual MP4.
//
// The actor is asked to download the video into its own key-value store
// (shouldDownloadVideos: true). It then surfaces the public KV-store URL in
// `mediaUrls[0]` / `videoMeta.downloadAddr` — fetch THOSE; no token needed and
// no TikTok origin in the path.
//
// `videoMeta.playAddr` / `raw.videoUrl` point at TikTok's own CDN, which
// 403s "Access Denied" from datacenter/server IPs (Contabo, Vercel, ...).
// The code refuses those rather than attempting the download and burning an
// Apify credit on a guaranteed-blocked request — the analysis degrades to
// text with a clear reason instead of a raw 403 HTML error.
// ---------------------------------------------------------------------------

export interface ResolvedVideoBinary {
  url: string;
  /** 'kv_store' = Apify key-value store (what we should use);
   *  'tiktok_cdn' = TikTok's own CDN (403s from servers — refuse). */
  source: 'kv_store' | 'tiktok_cdn';
}

/** TikTok's CDN hosts that 403 datacenter IPs. Apify KV-store records live on
 *  apify/r2/cloudfront hosts instead — so if a URL came back on one of these
 *  even from mediaUrls/downloadAddr (some actor runs drop the CDN URL there),
 *  refuse it rather than fetch a guaranteed 403. */
export function isTikTokCdnUrl(url: string): boolean {
  return /(?:^|\.)tiktokcdn\.com|(?:^|\.)tiktok\.com\/|v\d+(?:-webapp)?\.us\.tiktok|(?:^|\.)tik-tok\.com\//i.test(url);
}

/** True when the URL came from a "trusted" field but still points at TikTok's
 *  CDN — treat it as tiktok_cdn so the downloader refuses it. */
function refusedCdn(url: string): ResolvedVideoBinary {
  return { url, source: 'tiktok_cdn' };
}

export function resolveVideoBinaryUrl(rawItem: unknown): ResolvedVideoBinary | null {
  const raw = (rawItem ?? {}) as Record<string, unknown>;
  const videoMeta = (raw.videoMeta ?? raw.video ?? {}) as Record<string, unknown>;

  // Apify KV-store URL — the good path (clockworks stores the MP4 here). But
  // guarantee the URL is actually Apify storage, not a TikTok CDN host that
  // some actor runs surface through these fields.
  const mediaUrls = raw.mediaUrls;
  if (Array.isArray(mediaUrls) && typeof mediaUrls[0] === 'string' && mediaUrls[0]) {
    return isTikTokCdnUrl(mediaUrls[0]) ? refusedCdn(mediaUrls[0]) : { url: mediaUrls[0], source: 'kv_store' };
  }
  if (typeof videoMeta.downloadAddr === 'string' && videoMeta.downloadAddr) {
    return isTikTokCdnUrl(videoMeta.downloadAddr) ? refusedCdn(videoMeta.downloadAddr) : { url: videoMeta.downloadAddr, source: 'kv_store' };
  }

  // Everything left is TikTok's CDN — refuse it.
  const playAddr = videoMeta.playAddr;
  if (Array.isArray(playAddr) && typeof playAddr[0] === 'string' && playAddr[0]) {
    return { url: playAddr[0], source: 'tiktok_cdn' };
  }
  if (typeof playAddr === 'string' && playAddr) return { url: playAddr, source: 'tiktok_cdn' };
  if (typeof raw.videoUrl === 'string' && raw.videoUrl) return { url: raw.videoUrl, source: 'tiktok_cdn' };
  return null;
}

/** POST to one actor's run-sync-get-dataset-items endpoint; throws on any non-2xx or non-array response. */
async function runTikTokActor(actorId: string, input: Record<string, unknown>, apiKey: string): Promise<any[]> {
  const url = `${APIFY_API_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify actor ${actorId} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const rawItems = await res.json();
  if (!Array.isArray(rawItems)) {
    throw new Error(`Apify actor ${actorId} returned non-array response: ${JSON.stringify(rawItems).slice(0, 200)}`);
  }
  return rawItems;
}

/**
 * Runs the configured primary actor; on failure, falls back to
 * DEFAULT_TIKTOK_ACTOR_ID (unless the primary already IS the default, in
 * which case the failure is terminal — thrown as-is). `context` is a short
 * human label (query/URL) for the fallback log line.
 */
async function runTikTokActorWithFallback(
  input: Record<string, unknown>,
  apiKey: string,
  context: string,
): Promise<{ rawItems: any[]; actorId: string }> {
  const primary = primaryTikTokActorId();
  try {
    return { rawItems: await runTikTokActor(primary, input, apiKey), actorId: primary };
  } catch (err) {
    if (primary === DEFAULT_TIKTOK_ACTOR_ID) throw err;
    console.error(
      `[apify:actor-fallback] primary actor ${primary} failed for ${context} — falling back to ${DEFAULT_TIKTOK_ACTOR_ID}. `
      + `Reason: ${(err as Error).message}`,
    );
    return { rawItems: await runTikTokActor(DEFAULT_TIKTOK_ACTOR_ID, input, apiKey), actorId: DEFAULT_TIKTOK_ACTOR_ID };
  }
}

/**
 * Split one run's cost across the workspaces that share it.
 *
 * Integer cents, remainder to the first sharer, and a workspace appearing
 * twice (two of its sources tracking the same canonical query) pays twice —
 * it consumed two of the N shares. Never rounds a share to 0 when there is
 * cost to attribute: a cap that can be evaded by joining a big enough batch
 * is not a cap.
 */
export function splitSpend(
  workspaceIds: string[],
  totalCents: number,
): Array<{ workspaceId: string; cents: number }> {
  const ids = workspaceIds.length > 0 ? workspaceIds : [];
  if (ids.length === 0) return [];
  if (ids.length === 1) return [{ workspaceId: ids[0]!, cents: totalCents }];

  const per = Math.floor(totalCents / ids.length);
  const remainder = totalCents - per * ids.length;
  const byWorkspace = new Map<string, number>();
  ids.forEach((id, idx) => {
    const share = per + (idx === 0 ? remainder : 0);
    byWorkspace.set(id, (byWorkspace.get(id) ?? 0) + share);
  });
  return [...byWorkspace].map(([workspaceId, cents]) => ({ workspaceId, cents }));
}

// Estimated cost per result, in cents — FREE tier ($0.0037/result), the most
// expensive tier, used as a conservative upper bound for the pre-auth check.
const ESTIMATED_COST_PER_RESULT_CENTS = 0.37;
// Flat per-run "actor start" fee, in cents — tier-independent at $0.001.
const ESTIMATED_ACTOR_START_COST_CENTS = 0.1;
// Date-filter add-on (oldestPostDateUnified), flat ~$0.001 when set.
const ESTIMATED_DATE_FILTER_COST_CENTS = 0.1;

/**
 * What one actor run costs, in cents, for a given number of DATASET RECORDS.
 *
 * clockworks bills PAY_PER_EVENT: a flat actor start plus a per-result event.
 * `results` is therefore the raw dataset size, not the count that survived
 * normalization — an error/notice record is still a billed result.
 *
 * Passing the REQUESTED limit gives the conservative pre-auth estimate;
 * passing what actually came back gives the figure worth recording.
 */
export function apifyRunCostCents(results: number, dateFiltered: boolean): number {
  return Math.ceil(
    Math.max(0, results) * ESTIMATED_COST_PER_RESULT_CENTS
    + ESTIMATED_ACTOR_START_COST_CENTS
    + (dateFiltered ? ESTIMATED_DATE_FILTER_COST_CENTS : 0),
  );
}

export interface ApifyScrapeOptions {
  workspaceId: string;
  /**
   * Every workspace this ONE actor run is being made on behalf of, when a
   * multi-tenant batch shares a scrape. The cap check and the recorded spend
   * are split pro-rata across them, because that is literally what happened:
   * ten tenants sharing a $0.019 run consumed a fifth of a cent each, not
   * $0.019 each, and not $0.019 for whichever one the worker claimed first.
   *
   * Omit for a single-tenant scrape; it defaults to [workspaceId].
   */
  costShareWorkspaceIds?: string[];
  sourceType: 'creator' | 'keyword' | 'hashtag';
  query: string; // handle, keyword phrase, or hashtag (with or without #)
  limit: number; // max results
  /**
   * Creator scrapes only. Maps to clockworks `oldestPostDateUnified` —
   * only return videos posted on/after this time (PAY_PER_EVENT date-filter
   * add-on, ~$0.001). Used by incremental refresh so we pay for new posts,
   * not the creator's already-known catalogue.
   */
  postedAfter?: Date;
  /**
   * What this scrape is for — recorded on the UsageLog row so Apify spend can
   * be traced back to the source that caused it, and told apart from the
   * per-video analysis downloads that bill against the same cap.
   */
  refId?: string;
}

export interface ApifyScrapeResult {
  items: NormalizedVideo[];
  costCents: number; // actual cost charged (estimate for now)
  rawCount: number;
  actorRunId: string | null;
  /**
   * Human-readable reasons the actor returned no usable videos.
   *
   * The actor reports a bad input by putting a record IN the dataset rather
   * than failing the run — `{error, errorCode, url, input}` for a missing
   * profile/hashtag, `{authorMeta, note}` for a profile with no videos. Those
   * records carry no `id`, so normalization drops them and the run looks like
   * a clean scrape that happened to find nothing. It isn't: it is Apify telling
   * us the query is wrong, and it costs the same as a real scrape. Surfacing
   * them is the difference between "no new videos this run" and "this source
   * has never been valid".
   */
  notices: string[];
}

/** Pull the actor's own explanation out of records that aren't videos. */
function collectNotices(rawItems: any[]): string[] {
  const notices: string[] = [];
  for (const r of rawItems) {
    if (!r || typeof r !== 'object') continue;
    if (r.id || r.videoId || r.item_id) continue; // a real video record
    const input = typeof r.input === 'string' ? ` (input: ${r.input})` : '';
    if (typeof r.error === 'string') {
      notices.push(`Apify: ${r.error}${r.errorCode ? ` [${r.errorCode}]` : ''}${input}`);
    } else if (typeof r.note === 'string') {
      notices.push(`Apify: ${r.note}${input}`);
    } else {
      notices.push(`Apify returned an unrecognized record with keys: ${Object.keys(r).slice(0, 8).join(', ')}`);
    }
  }
  return notices;
}

/** Normalize raw actor records into usable videos, dropping anything that fails to parse or has no id. */
function normalizeItems(rawItems: any[]): NormalizedVideo[] {
  return rawItems
    .map(raw => {
      try {
        return normalizeTikTok(raw);
      } catch {
        return null;
      }
    })
    .filter((v): v is NormalizedVideo => v !== null && !!v.externalId);
}

// ---------------------------------------------------------------------------
// TikTok scraper — calls clockworks/tiktok-scraper
// ---------------------------------------------------------------------------

export async function scrapeTikTok(opts: ApifyScrapeOptions): Promise<ApifyScrapeResult> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error('APIFY_API_KEY is not set. Add it to .env (or the MCP server env block in your client config).');

  // Build the actor input. clockworks/tiktok-scraper accepts:
  //   - hashtags: array of hashtags (without #)
  //   - searchQueries: array of keywords
  //   - profiles: array of usernames (for sourceType=creator)
  //   - resultsPerPage: integer
  //   - profileSorting: latest | popular | oldest (creators)
  //   - oldestPostDateUnified: ISO/relative date filter (creators, ~$0.001)
  // See https://apify.com/clockworks/tiktok-scraper/input-schema
  const hashtag = opts.query.replace(/^#/, '').trim();
  // Date-filter add-on is a flat ~$0.001 when set — bake it into the estimate
  // so the spend-cap pre-auth stays conservative.
  const dateFiltered = !!opts.postedAfter && opts.sourceType === 'creator';
  // Pre-auth against the WORST case: every requested result comes back.
  const estimatedCostCents = apifyRunCostCents(opts.limit, dateFiltered);

  // Cap check per SHARER, not per run. A batched scrape is a shared purchase:
  // asserting the full estimate against one workspace let one tenant's cap be
  // consumed by (and breach on behalf of) nine others.
  const sharers = splitSpend(opts.costShareWorkspaceIds ?? [opts.workspaceId], estimatedCostCents);
  for (const s of sharers) await assertApifyCap(s.workspaceId, s.cents);

  const input: Record<string, unknown> = {
    resultsPerPage: opts.limit,
    // Have the actor copy cover images into its key-value store and list the
    // KV URLs in `mediaUrls`. Those are public, unsigned and not referer-gated,
    // unlike videoMeta.coverUrl which points at TikTok's own CDN with a signed,
    // short-lived URL that 403s bare requests. Media ingest reads the KV URL
    // (src/lib/media.ts) and only falls back to the TikTok CDN when the actor
    // returns none — `mediaUrls` is documented as sometimes empty.
    //
    // PPE does not charge the video-download event for covers (observed live).
    // Videos are NOT downloaded here: that stays on the analyze path
    // (downloadTikTokVideo), which pulls one video on demand.
    shouldDownloadCovers: true,
    shouldDownloadVideos: false,
    shouldDownloadSlideshowImages: false,
  };

  if (opts.sourceType === 'creator') {
    input.profiles = [opts.query.replace(/^@/, '').trim()];
    // Latest-first is the actor default; set explicitly so a future schema
    // change cannot silently switch us to "popular" (which re-returns the
    // same evergreen hits every refresh).
    input.profileSorting = 'latest';
    // Pinned posts are almost never "new outliers" — skip them so a small
    // resultsPerPage is not wasted on the same two pins every run.
    input.excludePinnedPosts = true;
    if (opts.postedAfter) {
      // Absolute ISO. Relative forms ("2 days") also work; absolute is
      // unambiguous against our watermark.
      input.oldestPostDateUnified = opts.postedAfter.toISOString();
    }
  } else if (opts.sourceType === 'hashtag') {
    input.hashtags = [hashtag];
  } else {
    // keyword
    input.searchQueries = [opts.query.trim()];
  }

  const context = `${opts.sourceType}="${opts.query}"`;
  const watermarkNote = opts.postedAfter ? ` postedAfter=${opts.postedAfter.toISOString()}` : '';
  console.log(
    `[apify] calling TikTok scraper (actor=${primaryTikTokActorId()}) for ${context} `
    + `limit=${opts.limit}${watermarkNote} (est cost: ${estimatedCostCents}c)`,
  );

  let { rawItems, actorId } = await runTikTokActorWithFallback(input, apiKey, context);
  let items = normalizeItems(rawItems);
  let notices = collectNotices(rawItems);
  // Bill what the run actually returned, not what we asked for. Recording the
  // requested limit made the refresh policy look like it was saving money by
  // construction: shrink `limit`, watch the recorded cost fall, whether or not
  // Apify returned fewer results. A creator watermark run that came back with
  // 1 result was booked at 3c on a 5-result estimate — a 3x overstatement, and
  // the direction that matters, since the cap then refuses work already paid
  // for. Never above the pre-auth: that is what the cap approved.
  let spentCents = Math.min(
    estimatedCostCents,
    apifyRunCostCents(rawItems.length, dateFiltered),
  );

  // runTikTokActorWithFallback only falls back to the default actor on an
  // HTTP failure. A misconfigured non-default actor (wrong input shape for
  // its own schema, e.g. `profiles` not formatted the way IT expects) can
  // still return 200 with an in-dataset "no videos for profile/hashtag"
  // record — that reads as a clean, successful empty scrape and never
  // triggers the existing fallback, even though the query is perfectly
  // valid. Confirmed live: every creator-source refresh in one workspace
  // failed identically this way across 3 different, real handles. Retry
  // once against the known-good default before accepting "nothing found".
  if (items.length === 0 && notices.length > 0 && actorId !== DEFAULT_TIKTOK_ACTOR_ID) {
    console.warn(
      `[apify] ${actorId} returned 0 usable videos for ${context} (${notices.join(' | ')}) `
      + `— retrying against ${DEFAULT_TIKTOK_ACTOR_ID}`,
    );
    const retryRawItems = await runTikTokActor(DEFAULT_TIKTOK_ACTOR_ID, input, apiKey);
    const retryItems = normalizeItems(retryRawItems);
    // A second full actor run really was started and really did return
    // records — bill it on its own dataset size, same as the first.
    spentCents += Math.min(
      estimatedCostCents,
      apifyRunCostCents(retryRawItems.length, dateFiltered),
    );
    if (retryItems.length > 0) {
      rawItems = retryRawItems;
      items = retryItems;
      notices = collectNotices(retryRawItems);
      actorId = DEFAULT_TIKTOK_ACTOR_ID;
    }
    // Retry also came back empty: keep the primary's notices — they're more
    // specific than a second identical "nothing found".
  }

  if (items.length === 0 && rawItems.length > 0) {
    console.warn(`[apify] ${rawItems.length} record(s) returned, 0 usable videos: ${notices.join(' | ')}`);
  }

  // Record cost per sharing workspace. Still modelled (Apify's per-call
  // billing is not in the response; the real invoice lands later) but now
  // modelled from the returned dataset size rather than the request.
  for (const s of splitSpend(opts.costShareWorkspaceIds ?? [opts.workspaceId], spentCents)) {
    await recordApifySpend(s.workspaceId, s.cents, opts.refId ?? null, 'source_scrape');
  }

  return {
    items,
    costCents: spentCents,
    rawCount: rawItems.length,
    actorRunId: null,
    notices,
  };
}

// ---------------------------------------------------------------------------
// Single TikTok video download — fetches one video by URL via
// clockworks/tiktok-scraper (with `videoUrls` input), then HTTP-GETs the MP4
// binary from TikTok's CDN. Used by the gemini-native analysis backend to
// obtain a local file for upload to Gemini. Replaces the prior yt-dlp
// subprocess dependency so the MCP server needs no external binaries.
//
// Cost: same actor, same per-result pricing — ~$0.001-0.005 per video on
// most tiers. Charged against the APIFY_SPEND_CAP_CENTS budget.
// ---------------------------------------------------------------------------

export interface ApifyDownloadOptions {
  workspaceId: string;
  videoUrl: string;     // TikTok watch URL (https://www.tiktok.com/@user/video/ID)
  outputPath: string;   // Local file path to save the MP4
}

export interface ApifyDownloadResult {
  costCents: number;
  sizeBytes: number;
  cdnUrl: string;       // The CDN URL the binary was fetched from
  actorRunId: string | null;
}

// Conservative per-video cost ceiling (1 result × free-tier max + actor start).
const ESTIMATED_DOWNLOAD_COST_CENTS = 1;

export async function downloadTikTokVideo(opts: ApifyDownloadOptions): Promise<ApifyDownloadResult> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error('APIFY_API_KEY is not set. Add it to .env (or the MCP server env block in your client config).');

  if (!opts.workspaceId) throw new Error('workspaceId is required (needed for spend-cap accounting).');

  // Pre-authorize against the spend cap
  await assertApifyCap(opts.workspaceId, ESTIMATED_DOWNLOAD_COST_CENTS);

  // Ask clockworks/tiktok-scraper for the actual video binary. We MUST set
  // shouldDownloadVideos: true — without it, the actor only returns metadata
  // (and `musicMeta.playUrl`, which is the audio-only MP3 stream — misleading
  // name). With it, the actor downloads the real H264/AAC MP4 to its key-value
  // store and exposes the KV-store URL via `mediaUrls[0]` and
  // `videoMeta.downloadAddr`. We then HTTP-GET that URL (no Apify token
  // required for public KV-store records).
  const input = {
    postURLs: [opts.videoUrl],
    shouldDownloadVideos: true,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
  };

  console.log(`[apify] fetching single video (actor=${primaryTikTokActorId()}) ${opts.videoUrl} (est cost: ${ESTIMATED_DOWNLOAD_COST_CENTS}c)`);

  const { rawItems } = await runTikTokActorWithFallback(input, apiKey, opts.videoUrl);
  if (rawItems.length === 0) {
    throw new Error(`Apify returned no items for video URL: ${opts.videoUrl}`);
  }

  const raw = rawItems[0];

  // Pick the Apify key-value-store URL for the real video binary. Only
  // present when shouldDownloadVideos=true was set in the input. NOTE:
  // `musicMeta.playUrl` is the AUDIO-ONLY stream (misleading name) and
  // MUST NOT be used — Gemini rejects it with code 13 "file failed to be
  // processed". If the actor only returned a TikTok CDN URL (playAddr /
  // videoUrl), refuse it — see resolveVideoBinaryUrl: TikTok's CDN 403s
  // datacenter IPs, so attempting it would burn an Apify credit for nothing.
  const resolved = resolveVideoBinaryUrl(raw);
  if (!resolved) {
    throw new Error('Apify returned no video binary (mediaUrls/downloadAddr absent) — video may be deleted or restricted');
  }
  if (resolved.source === 'tiktok_cdn') {
    throw new Error(`Actor did not store the video (only a TikTok CDN URL available — cannot download from a server IP); falling back to text analysis`);
  }
  const cdnUrl = resolved.url;

  // HTTP GET the MP4 binary from Apify's key-value store. These records
  // are public, but we send headers anyway in case we ever fall back to
  // a TikTok CDN URL (which requires User-Agent + Referer or it 403s).
  const videoRes = await fetch(cdnUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.tiktok.com/',
    },
  });

  if (!videoRes.ok) {
    const errText = await videoRes.text().catch(() => '');
    throw new Error(`TikTok CDN download failed (${videoRes.status}): ${errText.slice(0, 200)}`);
  }

  const arrayBuffer = await videoRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 1024) {
    throw new Error(`Downloaded file too small (${buffer.length} bytes) — likely an error page`);
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync(opts.outputPath, buffer);

  // Record actual cost (estimated — real invoice lands later). Tagged as a
  // video download so it is not mistaken for source-refresh spend: both bill
  // against the same Apify cap, but only one of them is the refresh policy's
  // to answer for.
  await recordApifySpend(
    opts.workspaceId,
    ESTIMATED_DOWNLOAD_COST_CENTS,
    opts.videoUrl,
    'video_download',
  );

  return {
    costCents: ESTIMATED_DOWNLOAD_COST_CENTS,
    sizeBytes: buffer.length,
    cdnUrl,
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
