// Cloudflare Stream as the frame server — the Workers-native replacement for
// ffmpeg frame extraction (Phase: the video→slideshow pipeline's only leg
// that workerd cannot do natively).
//
// Flow per video: `streamCopyFromUrl` hands Stream the SIGNED R2 URL (the
// Worker never touches video bytes), `streamVideoStatus` polls readyToStream
// (Stream processing can take up to ~5 min — callers step it across drain
// ticks rather than looping), `fetchStreamThumbnail` returns the JPEG at any
// timestamp (`?time=12s`), and `deleteStreamVideo` stops the storage billing
// once the frames are extracted.
//
// workerd-safe: pure fetch, no fs, no subprocess. Auth is a Cloudflare API
// token with Stream edit permission — CLOUDFLARE_STREAM_TOKEN, falling back
// to CLOUDFLARE_API_TOKEN (the deploy secret, if its scope allows Stream).

const STREAM_API = 'https://api.cloudflare.com/client/v4/accounts';

/** Minimal fetch shape so tests can inject lambdas; global fetch fits. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface StreamConfig {
  accountId: string;
  token: string;
}

export function streamConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): StreamConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_STREAM_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) return null;
  return { accountId, token };
}

export function streamRecreateConfigured(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): boolean {
  return streamConfig(env) !== null;
}

function authHeaders(config: StreamConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
}

/** Unwrap the `{ success, result, errors }` envelope, throwing on failure. */
async function unwrap(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
  try { data = JSON.parse(text); } catch {
    throw new Error(`Stream ${what} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || data.success === false) {
    const message = data.errors?.map(e => e.message).join('; ') || text.slice(0, 300);
    throw new Error(`Stream ${what} failed (${res.status}): ${message}`);
  }
  return (data.result ?? {}) as Record<string, unknown>;
}

/**
 * Have Stream ingest a video by URL (our signed R2 link) — no bytes through
 * the Worker. Resolves with the Stream UID once the copy is ACCEPTED; the
 * video is usually still processing at that point.
 */
export async function streamCopyFromUrl(
  config: StreamConfig,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const res = await fetchImpl(`${STREAM_API}/${config.accountId}/stream/copy`, {
    method: 'POST',
    headers: authHeaders(config),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ url }),
  });
  const result = await unwrap(res, 'copy');
  const uid = result.uid as string | undefined;
  if (!uid) throw new Error('Stream copy returned no uid');
  return uid;
}

export interface StreamVideoStatus {
  ready: boolean;
  state: string;
  error?: string | null;
  /** Base thumbnail URL, e.g. https://customer-<code>.cloudflarestream.com/<uid>/thumbnails/thumbnail.jpg */
  thumbnailUrl?: string | null;
  durationSec?: number | null;
}

export async function streamVideoStatus(
  config: StreamConfig,
  uid: string,
  fetchImpl: FetchLike = fetch,
): Promise<StreamVideoStatus> {
  const res = await fetchImpl(`${STREAM_API}/${config.accountId}/stream/${uid}`, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await unwrap(res, 'status');
  const state = (result.status as { state?: string } | undefined)?.state ?? 'unknown';
  return {
    ready: result.readyToStream === true,
    state,
    error: (result.status as { errorReasonCode?: string } | undefined)?.errorReasonCode ?? null,
    thumbnailUrl: (result.thumbnail as string | undefined) ?? null,
    durationSec: typeof result.duration === 'number' ? result.duration : null,
  };
}

/**
 * One frame as JPEG. `time` lands mid-shot (the plan guarantees it); the
 * thumbnail endpoint accepts seconds (`?time=4.5s`) or a percentage.
 */
export async function fetchStreamThumbnail(
  config: StreamConfig,
  uid: string,
  tSec: number,
  baseThumbnailUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<Uint8Array> {
  const base = baseThumbnailUrl || `https://customer-${config.accountId}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`;
  const url = `${base}${base.includes('?') ? '&' : '?'}time=${tSec}s&height=1080`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Stream thumbnail ${tSec}s failed (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 1024) throw new Error(`Stream thumbnail ${tSec}s too small (${buf.byteLength}b)`);
  return buf;
}

/** Stop storage billing once the frames are extracted. Best-effort: callers
 *  swallow errors — an orphaned copy costs fractions of a cent per day. */
export async function deleteStreamVideo(
  config: StreamConfig,
  uid: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const res = await fetchImpl(`${STREAM_API}/${config.accountId}/stream/${uid}`, {
    method: 'DELETE',
    headers: authHeaders(config),
    signal: AbortSignal.timeout(30_000),
  });
  await unwrap(res, 'delete');
}
