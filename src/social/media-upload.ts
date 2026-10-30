// Scheduler media storage shared by api/social-upload.ts (multipart) and the
// upload_social_media MCP tool (remote URL). Objects land in the THUMBS bucket
// under social/ and are returned as STABLE PUBLIC URLs — TikTok photo posts
// (PULL_FROM_URL) and Instagram containers fetch them later.
//
// Limits: images 20MB, videos 95MB (Workers request-body cap on the Free plan
// is 100MB — keep headroom for the multipart wrapper).

import { publicUrl, putObject, thumbBucket } from '../lib/storage.js';
import { assertPublicHttpUrl } from './fetch.js';
import { BadBodyError } from './errors.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 95 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};
const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export type UploadErrorCode = 'unsupported_type' | 'too_large' | 'storage_failed' | 'fetch_failed' | 'invalid_url';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface StoredMedia {
  url: string;
  type: 'image' | 'video';
  key: string;
  sizeBytes: number;
}

/** Normalised MIME → { ext, isVideo, maxBytes }, or null when unsupported. */
export function classifyMediaType(contentType: string): { ext: string; isVideo: boolean; maxBytes: number } | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  const ext = IMAGE_TYPES[type] ?? VIDEO_TYPES[type];
  if (!ext) return null;
  const isVideo = type in VIDEO_TYPES;
  return { ext, isVideo, maxBytes: isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES };
}

/** Validate type + size and write to THUMBS under social/. */
export async function storeSocialMedia(body: Uint8Array, contentType: string): Promise<StoredMedia> {
  const info = classifyMediaType(contentType);
  if (!info) throw new UploadError('unsupported_type', `Unsupported media type: ${contentType || 'unknown'}`, { type: contentType });
  if (body.byteLength <= 0 || body.byteLength > info.maxBytes) {
    throw new UploadError('too_large', `Media must be 1 byte to ${info.maxBytes} bytes`, { maxBytes: info.maxBytes, sizeBytes: body.byteLength });
  }

  const key = `social/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${info.ext}`;
  try {
    await putObject({ bucket: thumbBucket(), path: key, body, contentType: contentType.split(';')[0]!.trim().toLowerCase() });
  } catch (err) {
    console.error(`[social/upload] putObject failed: ${(err as Error).message}`);
    throw new UploadError('storage_failed', 'Storage write failed');
  }
  return { url: publicUrl(thumbBucket(), key), type: info.isVideo ? 'video' : 'image', key, sizeBytes: body.byteLength };
}

const FETCH_TIMEOUT_MS = 60_000;

/** Download a public http(s) media URL (size-capped while streaming) and store it. */
export async function storeSocialMediaFromUrl(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredMedia & { sourceUrl: string }> {
  try {
    assertPublicHttpUrl(sourceUrl);
  } catch (err) {
    throw new UploadError('invalid_url', (err as BadBodyError).message);
  }

  let response: Response;
  try {
    response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    throw new UploadError('fetch_failed', `Could not download the URL: ${(err as Error).message}`);
  }
  if (!response.ok) throw new UploadError('fetch_failed', `Source URL returned HTTP ${response.status}`, { status: response.status });
  // A redirect must not smuggle the fetch onto a non-public host.
  if (response.url) {
    try {
      assertPublicHttpUrl(response.url);
    } catch (err) {
      throw new UploadError('invalid_url', (err as BadBodyError).message);
    }
  }

  let contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!classifyMediaType(contentType)) {
    const ext = new URL(response.url || sourceUrl).pathname.split('.').pop()?.toLowerCase() ?? '';
    // Object stores often serve octet-stream; trust the extension only then.
    if (!contentType || contentType === 'application/octet-stream') contentType = EXT_TYPES[ext] ?? contentType;
  }
  const info = classifyMediaType(contentType);
  if (!info) throw new UploadError('unsupported_type', `Unsupported media type: ${contentType || 'unknown'}`, { type: contentType });

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > info.maxBytes) {
    throw new UploadError('too_large', `Media exceeds ${info.maxBytes} bytes`, { maxBytes: info.maxBytes, sizeBytes: declared });
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new UploadError('fetch_failed', 'Source URL returned no body');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > info.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UploadError('too_large', `Media exceeds ${info.maxBytes} bytes`, { maxBytes: info.maxBytes });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ...(await storeSocialMedia(body, contentType)), sourceUrl };
}
