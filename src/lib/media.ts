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
  isStorageEnabled, putObject, publicUrl, thumbBucket, mediaBucket, thumbPath, mediaPath,
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
    if (!target.coverDownloadUrl) {
      console.warn(`[media] ${target.videoId}: no Apify cover URL, falling back to the source CDN`);
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
      contentType: res.headers.get('content-type') || 'image/jpeg',
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
