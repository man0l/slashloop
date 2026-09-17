// Metadata-stripping re-capture ("clean-room" copies of uploaded media).
//
// The point: a scheduled post should carry none of the source file's
// fingerprint — no EXIF, no original encoder/container signatures. So every
// media item is RE-CAPTURED instead of passed through:
//   • images — decode → crop 2px → resize back to the exact original pixel
//     dimensions → fresh JPEG encode ("screenshot in the same aspect ratio /
//     pixel rate"; imperceptible, all-new bytes).
//   • videos — Cloudflare Stream ingest: Stream fully re-encodes the video
//     (its own encoder + container, nothing survives), we fetch the fresh
//     MP4 back into R2 and DELETE the Stream asset immediately — nothing
//     billable lingers (spend-bounds rule).
//
// Recreated slideshows are excluded upstream: gpt-image outputs are already
// fresh.
//
// Runs inside the engine tick (src/social/engine.ts), one media item per
// tick per post — decode CPU and Stream waits never sit inside an HTTP
// request. Workers-only (photon WASM + the R2 binding).

import { putObject, thumbBucket, publicUrl } from '../lib/storage.js';
import type { MediaContent } from './types.js';

export interface ScrubConfig {
  accountId: string;
  token: string;
}

const STREAM_API = 'https://api.cloudflare.com/client/v4/accounts';

// ── images ──────────────────────────────────────────────────────────────────

/** Re-encode an image with a 2px edge crop restored to the original
 *  dimensions. Returns fresh bytes with the original pixel size. */
export async function scrubImageBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const photon = await import('@cf-wasm/photon');
  const image = photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  const width = image.get_width();
  const height = image.get_height();
  // Guard tiny images: the crop must leave something to resize.
  if (width <= 8 || height <= 8) {
    return new Uint8Array(image.get_bytes_jpeg(88));
  }
  const cropped = photon.crop(image, 2, 2, width - 4, height - 4);
  const restored = photon.resize(cropped, width, height, photon.SamplingFilter.Lanczos3);
  return new Uint8Array(restored.get_bytes_jpeg(88));
}

/** Fetch → scrub → store under a fresh social/ key. Returns the new public URL. */
export async function scrubImageToR2(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read the image for re-encode (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const scrubbed = await scrubImageBytes(bytes);
  const key = `social/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  await putObject({ bucket: thumbBucket(), path: key, body: scrubbed, contentType: 'image/jpeg' });
  return publicUrl(thumbBucket(), key);
}

// ── video (Cloudflare Stream) ───────────────────────────────────────────────

async function streamApi(cfg: ScrubConfig, path: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const response = await fetch(`${STREAM_API}/${cfg.accountId}/stream${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || body?.success === false) {
    throw new Error(body?.errors?.[0]?.message || `Stream ${path || 'upload'} failed (${response.status})`);
  }
  return body;
}

/** Push the video bytes to Stream (direct single-request upload; composer
 *  caps videos at 95MB, well inside the direct limit). Returns the uid. */
export async function streamUpload(cfg: ScrubConfig, url: string): Promise<string> {
  const source = await fetch(url);
  if (!source.ok || !source.body) throw new Error(`Could not read the video for re-encode (${source.status})`);
  const body = await streamApi(cfg, '', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: source.body,
  });
  const uid = body?.result?.uid;
  if (!uid) throw new Error('Stream did not return a video id');
  return String(uid);
}

/** Stream processing state: 'inprogress' | 'ready' | 'error' | 'not-found'. */
export async function streamStatus(cfg: ScrubConfig, uid: string): Promise<'inprogress' | 'ready' | 'error'> {
  const body = await streamApi(cfg, `/${uid}`).catch(() => ({ result: undefined }));
  const state = body?.result?.status?.state;
  if (state === 'ready' || body?.result?.readyToStream) return 'ready';
  if (state === 'error') return 'error';
  return 'inprogress';
}

/** Enable + fetch the re-encoded MP4 download link. Null while Stream is
 *  still producing it — the caller keeps polling on later ticks. */
export async function streamDownloadUrl(cfg: ScrubConfig, uid: string): Promise<string | null> {
  await streamApi(cfg, `/${uid}/downloads`, { method: 'POST' }).catch(() => undefined);
  const body = await streamApi(cfg, `/${uid}/downloads`).catch(() => ({ result: undefined }));
  const url = body?.result?.default?.url ?? body?.result?.renditions?.[0]?.url;
  return typeof url === 'string' && url ? url : null;
}

/** Fetch the re-encoded MP4 and store it under a fresh social/ key. */
export async function streamDownloadToR2(cfg: ScrubConfig, url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not fetch the re-encoded video (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const key = `social/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp4`;
  await putObject({ bucket: thumbBucket(), path: key, body: bytes, contentType: 'video/mp4' });
  return publicUrl(thumbBucket(), key);
}

/** Remove the transient Stream asset — called right after the MP4 lands in
 *  R2 and by the orphan sweep, so no billable minutes can outlive the job. */
export async function streamDelete(cfg: ScrubConfig, uid: string): Promise<void> {
  await fetch(`${STREAM_API}/${cfg.accountId}/stream/${uid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.token}` },
  }).catch(() => undefined);
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/** First media item still awaiting scrub, or null when everything is done. */
export function nextScrubItem(media: MediaContent[]): { index: number; item: MediaContent } | null {
  const index = media.findIndex((item) => item.scrub === true);
  return index === -1 ? null : { index, item: media[index] };
}

/** Replace one media item's URL + clear its scrub flag (by index). */
export function mediaWithScrubbedUrl(media: MediaContent[], index: number, url: string): MediaContent[] {
  return media.map((item, i) => (i === index ? { ...item, url, scrub: false } : item));
}
