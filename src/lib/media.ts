// ---------------------------------------------------------------------------
// Media ingest — fetching source media and putting it in Supabase Storage.
//
// Split from storage.ts on purpose: storage.ts is the vendor surface (swap it
// for R2 and nothing else changes), this is the slashloop-specific policy about
// what gets stored, from where, and what happens when it fails.
//
// TikTok only. See docs/media-storage-plan.md §0.3 — reels/shorts have no
// scraper, but create_source still accepts those platforms, so rows for them
// can exist and must never reach a fetch.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import {
  isStorageEnabled, putObject, publicUrl, signUrl, signedUrlTtlSeconds,
  thumbBucket, mediaBucket, thumbPath, mediaPath,
} from './storage.js';

/**
 * Only needed for the SOURCE-CDN fallback. TikTok's CDN 403s bare requests, so
 * these mirror what the video download already sends. Apify's key-value store
 * is public and needs no headers — and is the path we want to be on.
 */
const TIKTOK_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.tiktok.com/',
};

function isApifyHosted(url: string): boolean {
  return /^https?:\/\/[^/]*\bapify\.com\//i.test(url);
}

/** The image types the `thumbs` bucket is provisioned to allow (see the buckets migration). */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * Coerce an upstream Content-Type into a real image type.
 *
 * Apify's key-value store commonly serves stored records as
 * application/octet-stream, and whatever we pass here is what Supabase stores
 * and later serves the object with. Two reasons that matters:
 *
 *   - The stored Content-Type is what the public thumb URL returns. Serving a
 *     cover as application/octet-stream invites a download rather than a render.
 *   - Where the bucket has an image allowlist — a fresh environment provisioned
 *     by the buckets migration — passing octet-stream through would 400 the
 *     upload outright, on exactly the source we prefer.
 *
 * Buckets created by hand have no allowlist, so the second only bites on new
 * environments. The first applies everywhere.
 *
 * Falls back to the URL's extension, then to JPEG, which is what TikTok covers
 * actually are.
 */
function imageContentType(headerValue: string | null, url: string): string {
  const header = (headerValue ?? '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_IMAGE_TYPES.includes(header)) return header;

  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    default: return 'image/jpeg';
  }
}

/** Only these platforms have a real scraper and real CDN URLs behind them. */
export function isIngestablePlatform(platform: string): boolean {
  return platform === 'tiktok';
}

const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const THUMB_FETCH_TIMEOUT_MS = 10_000;
const THUMB_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

export interface ThumbIngestTarget {
  videoId: string;
  platform: string;
  /** Source-CDN URL. Fallback only — signed and short-lived on TikTok. */
  thumbnailUrl: string;
  /** Apify key-value-store URL. Preferred: public, unsigned, no referer gate. */
  coverDownloadUrl?: string | null;
}

/**
 * Fetch one cover image and store it. Returns the object key on success, null
 * on any failure — callers record 'failed' and move on. A thumbnail is never
 * worth failing a scrape over; the scrape is the expensive thing.
 *
 * Source preference: Apify's key-value store first (that's why the scrape sets
 * `shouldDownloadCovers`), the platform CDN only as a fallback for when the
 * actor returns no KV URL.
 */
async function ingestOneThumb(
  workspaceId: string,
  target: ThumbIngestTarget,
): Promise<string | null> {
  const source = target.coverDownloadUrl || target.thumbnailUrl;
  if (!source) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMB_FETCH_TIMEOUT_MS);

  try {
    // Report the host actually being fetched, not just which field was empty.
    // The old wording claimed a CDN fallback whenever coverDownloadUrl was
    // null — which was every run, while the fetch was in fact hitting Apify
    // through thumbnailUrl. A warning that misreports the source is worse
    // than none: it hid that pickApifyCoverUrl never matched.
    if (!target.coverDownloadUrl) {
      const host = isApifyHosted(source) ? 'apify' : 'source cdn';
      console.warn(`[media] ${target.videoId}: no coverDownloadUrl, fetching cover from ${host}`);
    }

    const res = await fetch(source, {
      // Apify KV is public; the spoofed headers are only for the CDN fallback.
      headers: isApifyHosted(source) ? {} : TIKTOK_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`cover fetch ${res.status} from ${isApifyHosted(source) ? 'apify' : 'source cdn'}`);

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 512) throw new Error(`cover too small (${buf.byteLength}b) — likely an error page`);
    if (buf.byteLength > MAX_THUMB_BYTES) throw new Error(`cover too large (${buf.byteLength}b)`);

    const path = thumbPath(workspaceId, target.videoId);
    await putObject({
      bucket: thumbBucket(),
      path,
      body: buf,
      contentType: imageContentType(res.headers.get('content-type'), source),
    });
    return path;
  } catch (err) {
    console.warn(`[media] thumbnail ingest failed for ${target.videoId}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ingest a batch of thumbnails concurrently and persist the results.
 *
 * Runs AFTER the caller's insert loop, not inside it: a 50-video refresh must
 * not become 50 sequential round-trips inside a 60s function.
 *
 * Never throws. Returns counts for the refresh log.
 */
export async function ingestThumbnails(
  workspaceId: string,
  targets: ThumbIngestTarget[],
): Promise<{ stored: number; failed: number; skipped: number }> {
  const result = { stored: 0, failed: 0, skipped: 0 };
  if (!isStorageEnabled()) {
    result.skipped = targets.length;
    return result;
  }

  const ingestable = targets.filter(t => isIngestablePlatform(t.platform));
  result.skipped = targets.length - ingestable.length;

  for (let i = 0; i < ingestable.length; i += THUMB_CONCURRENCY) {
    const batch = ingestable.slice(i, i + THUMB_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(async t => ({ videoId: t.videoId, path: await ingestOneThumb(workspaceId, t) })),
    );

    await Promise.all(outcomes.map(async o => {
      try {
        await db.video.update({
          where: { id: o.videoId },
          data: o.path
            ? { thumbKey: o.path, thumbStatus: 'stored', thumbStoredAt: new Date() }
            : { thumbStatus: 'failed' },
        });
        if (o.path) result.stored++; else result.failed++;
      } catch (err) {
        console.warn(`[media] thumb status write failed for ${o.videoId}: ${(err as Error).message}`);
        result.failed++;
      }
    }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Video binaries
// ---------------------------------------------------------------------------

/**
 * Store an already-downloaded MP4 and record the key.
 *
 * Called from the analyze path once Apify has produced the file. Failure is
 * logged and swallowed: by the time this runs the expensive work (scrape +
 * download) is done and the analysis is about to succeed, so losing the cache
 * copy must not lose the analysis.
 *
 * Phase 1 keeps the existing buffer-to-tmpfile flow; streaming is Phase 3.
 */
export async function ingestVideoFile(
  workspaceId: string,
  videoId: string,
  filePath: string,
): Promise<{ mediaKey: string; bytes: number } | null> {
  if (!isStorageEnabled()) return null;

  try {
    const { readFileSync } = await import('node:fs');
    const buf = new Uint8Array(readFileSync(filePath));
    const path = mediaPath(workspaceId, videoId);

    await putObject({
      bucket: mediaBucket(),
      path,
      body: buf,
      contentType: 'video/mp4',
    });

    await db.video.update({
      where: { id: videoId },
      data: {
        mediaKey: path,
        mediaStatus: 'stored',
        mediaBytes: buf.byteLength,
        mediaStoredAt: new Date(),
      },
    });

    console.log(`[media] stored ${(buf.byteLength / 1024 / 1024).toFixed(2)}MB for ${videoId}`);
    return { mediaKey: path, bytes: buf.byteLength };
  } catch (err) {
    console.warn(`[media] video ingest failed for ${videoId}: ${(err as Error).message}`);
    await db.video.update({ where: { id: videoId }, data: { mediaStatus: 'failed' } }).catch(() => {});
    return null;
  }
}

/**
 * Download a video's MP4 via Apify and store it — WITHOUT running Gemini.
 *
 * This is the "fetch video" path: it makes a TikTok playable in the gallery
 * (mediaKey / mediaStatus='stored') so the inline <video> and key-moment
 * seeking work, independent of an analysis run. Reuses the exact download +
 * ingest legs as the analyze path (analyzeVideoWithDownload), minus Gemini.
 *
 * TikTok only — downloadTikTokVideo drives the clockworks/tiktok-scraper
 * actor. Apify spend is asserted + recorded inside downloadTikTokVideo, so the
 * fetch flow is governed by the Apify spend cap, not AI credits. Returns the
 * stored bytes, or null on any failure; callers record 'failed' and move on.
 */
export async function downloadAndStoreVideo(
  workspaceId: string,
  videoId: string,
  videoUrl: string,
): Promise<{ bytes: number } | null> {
  if (!isStorageEnabled()) return null;

  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { downloadTikTokVideo } = await import('./apify.js');

  const tmpDir = mkdtempSync(join(tmpdir(), 'slashloop-fetch-'));
  const filePath = join(tmpDir, `video_${videoId.slice(0, 8)}.mp4`);

  try {
    const dl = await downloadTikTokVideo({ workspaceId, videoUrl, outputPath: filePath });
    const { statSync } = await import('node:fs');
    if (statSync(filePath).size < 1024) throw new Error('downloaded file too small');

    const stored = await ingestVideoFile(workspaceId, videoId, filePath);
    return stored ? { bytes: dl.sizeBytes } : null;
  } catch (err) {
    console.warn(`[media] fetch failed for ${videoId}: ${(err as Error).message}`);
    await db.video.update({ where: { id: videoId }, data: { mediaStatus: 'failed' } }).catch(() => {});
    return null;
  } finally {
    const { rmSync } = await import('node:fs');
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Pull a previously stored MP4 back down to a local path.
 *
 * The read side of ingestVideoFile, and the mechanism behind Phase 2.1: a
 * re-analysis inside the retention window needs the bytes, not a fresh Apify
 * run. Uses a short-lived signed URL because `media` is private.
 *
 * Returns null rather than throwing on any failure. The caller's fallback is to
 * pay Apify, which is worse but correct — a stale key, an object swept by
 * retention between the DB read and this fetch, or storage being disabled must
 * degrade to the slow path, not lose the analysis.
 */
export async function fetchStoredVideo(
  mediaKey: string,
  outputPath: string,
): Promise<{ bytes: number } | null> {
  if (!isStorageEnabled()) return null;

  try {
    const url = await signUrl(mediaBucket(), mediaKey, signedUrlTtlSeconds());
    const res = await fetch(url);
    if (!res.ok) throw new Error(`signed GET ${res.status}`);

    const buf = new Uint8Array(await res.arrayBuffer());
    // Same floor ingestOneThumb uses: anything this small is an error page.
    if (buf.byteLength < 1024) throw new Error(`stored object too small (${buf.byteLength}b)`);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(outputPath, buf);
    return { bytes: buf.byteLength };
  } catch (err) {
    console.warn(`[media] could not reuse stored MP4 ${mediaKey}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A signed URL for the stored MP4, or the reason there isn't one.
 *
 * Signed ONCE per call even though callers fan it out across many key moments:
 * a media fragment (`#t=12.5`) is evaluated by the client and never sent to the
 * server, so it is not part of what gets signed. One signature serves every
 * moment in the video — signing per timestamp would be N round-trips for
 * identical URLs.
 *
 * This is what makes recreation frames free: no extraction, no second copy of
 * the video, no decoder. The "screenshot" is the stored MP4 seeked to a point.
 *
 * The tradeoff is lifetime. `media` is swept on the workspace's retention
 * window (3 days by default), so these URLs stop resolving once the object is
 * gone — the analysis text survives, the imagery does not. Durable recreation
 * stills would mean extracting keyframes at analysis time and keeping those
 * instead; a handful of JPEGs outlives a 4MB MP4 far more cheaply.
 */
export async function signedMediaUrl(
  video: { mediaKey: string | null; mediaStatus: string },
): Promise<{ url: string | null; reason?: string }> {
  if (!isStorageEnabled()) return { url: null, reason: 'storage_disabled' };
  if (video.mediaStatus === 'expired') return { url: null, reason: 'media_expired' };
  if (!video.mediaKey || video.mediaStatus !== 'stored') return { url: null, reason: 'media_not_stored' };

  try {
    return { url: await signUrl(mediaBucket(), video.mediaKey, signedUrlTtlSeconds()) };
  } catch (err) {
    console.warn(`[media] could not sign ${video.mediaKey}: ${(err as Error).message}`);
    return { url: null, reason: 'sign_failed' };
  }
}

/** Seek a signed media URL to a timestamp. Fragment only — never re-signs. */
export function frameUrlAt(signedUrl: string, timestampSec: number): string {
  return `${signedUrl}#t=${Math.max(0, timestampSec).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * What the UI should render for a video's thumbnail.
 *
 * Prefers the stored copy, falls back to the original source URL — which is
 * still correct for YouTube (i.ytimg.com never expires) and is the best
 * available guess for a TikTok row scraped in the last few hours.
 */
export function resolveThumbUrl(
  video: { thumbKey: string | null; thumbnailUrl: string },
): string | null {
  // isStorageEnabled() guards publicUrl(), which needs SUPABASE_URL.
  if (video.thumbKey && isStorageEnabled()) {
    return publicUrl(thumbBucket(), video.thumbKey);
  }
  return video.thumbnailUrl || null;
}
