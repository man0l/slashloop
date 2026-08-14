// ---------------------------------------------------------------------------
// Media object storage — vendor surface for thumbs + MP4s.
//
// Backends (first match wins):
//   1. Cloudflare R2  — when R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY
//   2. Supabase Storage — when SUPABASE_URL + SUPABASE_SECRET_KEY
//
// Same path shape either way: {workspaceId}/{videoId}.{ext}. Callers never
// branch on vendor. See docs/media-storage-plan.md.
//
// Unset both backends and every ingest path no-ops (isStorageEnabled() false).
// ---------------------------------------------------------------------------

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const DEFAULT_THUMB_BUCKET = 'thumbs';
const DEFAULT_MEDIA_BUCKET = 'media';
const DEFAULT_R2_THUMB_BUCKET = 'slashloop-thumbs';
const DEFAULT_R2_MEDIA_BUCKET = 'slashloop-media';

// ---- Backend selection ----------------------------------------------------

export type StorageBackend = 'r2' | 'supabase' | 'none';

export function storageBackend(): StorageBackend {
  if (isR2Configured()) return 'r2';
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) return 'supabase';
  return 'none';
}

function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY,
  );
}

/**
 * Storage is optional. Callers check this before doing any ingest work so a
 * deployment without credentials set skips the whole path silently rather
 * than logging a failure per video.
 */
export function isStorageEnabled(): boolean {
  return storageBackend() !== 'none';
}

export function thumbBucket(): string {
  if (storageBackend() === 'r2') {
    return process.env.R2_THUMB_BUCKET
      || process.env.STORAGE_THUMB_BUCKET
      || DEFAULT_R2_THUMB_BUCKET;
  }
  return process.env.STORAGE_THUMB_BUCKET || DEFAULT_THUMB_BUCKET;
}

export function mediaBucket(): string {
  if (storageBackend() === 'r2') {
    return process.env.R2_MEDIA_BUCKET
      || process.env.STORAGE_MEDIA_BUCKET
      || DEFAULT_R2_MEDIA_BUCKET;
  }
  return process.env.STORAGE_MEDIA_BUCKET || DEFAULT_MEDIA_BUCKET;
}

// ---- Paths ----------------------------------------------------------------
// Platform-free: {workspaceId}/{videoId}.{ext}. Workspace prefix makes
// per-workspace bulk delete cheap and isolates customers.

export function thumbPath(workspaceId: string, videoId: string): string {
  return `${workspaceId}/${videoId}.jpg`;
}

export function mediaPath(workspaceId: string, videoId: string): string {
  return `${workspaceId}/${videoId}.mp4`;
}

/** Public thumb-bucket key for one photo-carousel slide. */
export function slideshowPath(workspaceId: string, videoId: string, index: number): string {
  return `${workspaceId}/${videoId}/slides/${String(index).padStart(2, '0')}.jpg`;
}

// ---- R2 / S3 client -------------------------------------------------------

let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
  if (r2Client) return r2Client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 is not configured (need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  r2Client = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // R2 is path-style friendly; virtual-hosted also works with the account endpoint.
    forcePathStyle: true,
  });
  return r2Client;
}

// ---- Supabase helpers -----------------------------------------------------

function storageBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set');
  return `${url.replace(/\/$/, '')}/storage/v1`;
}

function authHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set');
  return { Authorization: `Bearer ${key}`, apikey: key };
}

// ---- Operations -----------------------------------------------------------

export interface PutObjectOptions {
  bucket: string;
  path: string;
  body: Uint8Array;
  contentType: string;
  /** Overwrite an existing object at the same path. Default true. */
  upsert?: boolean;
}

export async function putObject(opts: PutObjectOptions): Promise<{ path: string; sizeBytes: number }> {
  const { bucket, path, body, contentType } = opts;
  const backend = storageBackend();

  if (backend === 'r2') {
    await getR2Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: path,
      Body: body,
      ContentType: contentType,
      CacheControl: 'max-age=31536000',
    }));
    return { path, sizeBytes: body.byteLength };
  }

  if (backend === 'supabase') {
    const upsert = opts.upsert ?? true;
    const res = await fetch(`${storageBase()}/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': contentType,
        'Cache-Control': 'max-age=31536000',
        ...(upsert ? { 'x-upsert': 'true' } : {}),
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Storage upload failed (${res.status}) for ${bucket}/${path}: ${text.slice(0, 300)}`);
    }
    return { path, sizeBytes: body.byteLength };
  }

  throw new Error('Storage is not configured');
}

/**
 * Permanent URL for an object in a PUBLIC bucket. String concatenation, no
 * round-trip — thumbnails live public so get_feed can resolve N of them
 * without N network calls, and a CDN can cache them.
 */
export function publicUrl(bucket: string, path: string): string {
  const backend = storageBackend();

  if (backend === 'r2') {
    const base = (process.env.R2_THUMB_PUBLIC_BASE || process.env.R2_PUBLIC_BASE || '')
      .replace(/\/$/, '');
    if (!base) {
      throw new Error(
        'R2 public URL requested but R2_THUMB_PUBLIC_BASE is unset '
        + '(enable r2.dev public access on the thumbs bucket)',
      );
    }
    return `${base}/${path}`;
  }

  if (backend === 'supabase') {
    return `${storageBase()}/object/public/${bucket}/${path}`;
  }

  throw new Error('Storage is not configured');
}

/**
 * Time-limited URL for an object in a PRIVATE bucket. One round-trip per call,
 * so mint these on demand for a single video — never in a list endpoint.
 */
export async function signUrl(bucket: string, path: string, ttlSeconds: number): Promise<string> {
  const backend = storageBackend();

  if (backend === 'r2') {
    const url = await getSignedUrl(
      getR2Client(),
      new GetObjectCommand({ Bucket: bucket, Key: path }),
      { expiresIn: ttlSeconds },
    );
    return url;
  }

  if (backend === 'supabase') {
    const res = await fetch(`${storageBase()}/object/sign/${bucket}/${path}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Storage sign failed (${res.status}) for ${bucket}/${path}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = data.signedURL ?? data.signedUrl;
    if (!signed) throw new Error(`Storage sign returned no URL for ${bucket}/${path}`);
    return `${storageBase()}${signed.startsWith('/') ? '' : '/'}${signed}`;
  }

  throw new Error('Storage is not configured');
}

/**
 * Bulk delete. Returns the number of paths we attempted (or that S3 accepted).
 * Used by the retention sweeper — delete objects first, then null DB columns.
 */
export async function deleteObjects(bucket: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const backend = storageBackend();

  if (backend === 'r2') {
    // S3 DeleteObjects max 1000 keys per call.
    let deleted = 0;
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      const Objects: ObjectIdentifier[] = chunk.map((Key) => ({ Key }));
      const out = await getR2Client().send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects, Quiet: true },
      }));
      deleted += chunk.length - (out.Errors?.length ?? 0);
      if (out.Errors?.length) {
        console.warn(
          `[storage] R2 delete partial failures on ${bucket}: `
          + out.Errors.slice(0, 3).map((e) => `${e.Key}:${e.Code}`).join(', '),
        );
      }
    }
    return deleted;
  }

  if (backend === 'supabase') {
    const res = await fetch(`${storageBase()}/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Storage delete failed (${res.status}) on ${bucket}: ${text.slice(0, 300)}`);
    }
    return paths.length;
  }

  throw new Error('Storage is not configured');
}

/** TTL for signed media URLs. Default 24h. */
export function signedUrlTtlSeconds(): number {
  const n = Number(process.env.MEDIA_SIGNED_URL_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}
