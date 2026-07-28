// ---------------------------------------------------------------------------
// Supabase Storage — the entire vendor surface for media persistence.
//
// Deliberately hand-rolled over the Storage REST API rather than pulling in
// @supabase/supabase-js: the repo has no server-side Supabase client today,
// this is four HTTP calls, and the same fetch-client style is already used for
// Apify and Gemini. Keeping the vendor surface to one small module is also
// what makes a future move to R2 a single-file change
// (see docs/media-storage-plan.md §5).
//
// Everything here is a no-op when SUPABASE_SECRET_KEY is unset. Phase 1 must
// be additive and skippable — a deploy without storage configured behaves
// exactly as it did before.
// ---------------------------------------------------------------------------

const DEFAULT_THUMB_BUCKET = 'thumbs';
const DEFAULT_MEDIA_BUCKET = 'media';

export function thumbBucket(): string {
  return process.env.STORAGE_THUMB_BUCKET || DEFAULT_THUMB_BUCKET;
}

export function mediaBucket(): string {
  return process.env.STORAGE_MEDIA_BUCKET || DEFAULT_MEDIA_BUCKET;
}

/**
 * Storage is optional. Callers check this before doing any ingest work so a
 * deployment without the secret key set skips the whole path silently rather
 * than logging a failure per video.
 */
export function isStorageEnabled(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function storageBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set');
  return `${url.replace(/\/$/, '')}/storage/v1`;
}

function authHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set');
  // Supabase Storage wants both — Authorization for the service role and
  // apikey for the gateway in front of it.
  return { Authorization: `Bearer ${key}`, apikey: key };
}

// ---- Object paths ---------------------------------------------------------
// Deliberately platform-free: {workspaceId}/{videoId}.{ext}. The workspace
// prefix is what makes a per-workspace bulk delete cheap, and keeps one
// customer's media from colliding with another's.

export function thumbPath(workspaceId: string, videoId: string): string {
  return `${workspaceId}/${videoId}.jpg`;
}

export function mediaPath(workspaceId: string, videoId: string): string {
  return `${workspaceId}/${videoId}.mp4`;
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
  const { bucket, path, body, contentType, upsert = true } = opts;

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

/**
 * Permanent URL for an object in a PUBLIC bucket. String concatenation, no
 * round-trip — this is why thumbnails live in a public bucket: get_feed can
 * resolve N of them without N network calls, and Supabase's CDN can cache
 * them (a signed URL's per-call token defeats that).
 */
export function publicUrl(bucket: string, path: string): string {
  return `${storageBase()}/object/public/${bucket}/${path}`;
}

/**
 * Time-limited URL for an object in a PRIVATE bucket. One round-trip per call,
 * so mint these on demand for a single video — never in a list endpoint.
 */
export async function signUrl(bucket: string, path: string, ttlSeconds: number): Promise<string> {
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

  // The API returns a path like /object/sign/bucket/key?token=...
  return `${storageBase()}${signed.startsWith('/') ? '' : '/'}${signed}`;
}

/**
 * Bulk delete. Returns the number of paths accepted by the API — used by the
 * retention sweeper, which must know what actually went before it nulls the
 * DB columns.
 */
export async function deleteObjects(bucket: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;

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

/** TTL for signed media URLs. Default 24h. */
export function signedUrlTtlSeconds(): number {
  const n = Number(process.env.MEDIA_SIGNED_URL_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}
