// ---------------------------------------------------------------------------
// Post covers for slashloop.dev creator pages (SLA-1146). TikTok oEmbed no longer
// returns a thumbnail, and the signed CDN cover URLs on each post expire, so the
// profile job re-hosts the covers of up to MAX_COVERS outlier posts: it downloads
// each one straight from the CDN (off-proxy, like ingest does) and pushes the
// bytes to the site in one signed POST. The result then lists the stored ids.
// Best effort throughout: a missing cover never fails the profile job.
// ---------------------------------------------------------------------------

import { signedCallbackHeaders } from './tools-jobs.js';

export const MAX_COVERS = 6;
export const MAX_COVER_BYTES = 200 * 1024;
export const SITE_COVERS_PATH = '/tools/api/internal/covers';
const COVER_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 10_000;
const CONTENT_TYPES = new Set(['image/jpeg', 'image/webp', 'image/png']);
/** TikTok's image CDNs only: the URL comes from a scraped row and must not be an arbitrary fetch target. */
const COVER_HOST = /(^|\.)(tiktokcdn(-us|-eu)?\.com|ibyteimg\.com)$/;

export interface CoverTarget {
  id: string;
  url: string;
}

export interface CoverDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  siteUrl: string;
  secret: string;
  nowSeconds(): number;
  nonce(): string;
}

export function coverUrlOf(item: any): string | null {
  const v = item?.video ?? {};
  for (const candidate of [v.cover, v.originCover, item?.coverUrl, item?.originCoverUrl]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol === 'https:' && COVER_HOST.test(u.hostname)) return u.toString();
    } catch {
      // try the next field
    }
  }
  return null;
}

/** Cover URLs for the first MAX_COVERS outliers, in outlier order, skipping posts without one. */
export function coverTargets(items: any[], outlierIds: readonly string[]): CoverTarget[] {
  const byId = new Map<string, string>();
  for (const item of items) {
    const id = String(item?.id ?? item?.video?.id ?? '');
    const url = coverUrlOf(item);
    if (id && url && !byId.has(id)) byId.set(id, url);
  }
  return outlierIds
    .slice(0, MAX_COVERS)
    .flatMap((id) => (byId.has(id) ? [{ id, url: byId.get(id) as string }] : []));
}

type Downloaded = { id: string; contentType: string; data: string };
type DownloadResult = { ok: true; cover: Downloaded } | { ok: false; id: string; reason: string };

const reject = (id: string, reason: string): DownloadResult => ({ ok: false, id, reason });

/** Short, URL-free reason strings so a log line never carries a signed URL. */
async function download(target: CoverTarget, deps: CoverDeps): Promise<DownloadResult> {
  try {
    const res = await deps.fetch(target.url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) return reject(target.id, `http_${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!CONTENT_TYPES.has(contentType)) return reject(target.id, `type_${contentType.replace(/[^a-z0-9/+.-]/g, '') || 'none'}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_COVER_BYTES) return reject(target.id, 'too_large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return reject(target.id, 'empty');
    if (bytes.length > MAX_COVER_BYTES) return reject(target.id, 'too_large');
    return { ok: true, cover: { id: target.id, contentType, data: bytes.toString('base64') } };
  } catch (err) {
    return reject(target.id, `error_${(err as Error).name || 'unknown'}`);
  }
}

const rejections = (results: DownloadResult[]): string =>
  results.flatMap((r) => (r.ok ? [] : [`${r.id}:${r.reason}`])).join(',');

async function push(handle: string | null, covers: object[], deps: CoverDeps, label: string): Promise<string[]> {
  const url = `${deps.siteUrl.replace(/\/+$/, '')}${SITE_COVERS_PATH}`;
  const body = JSON.stringify(handle ? { handle, covers } : { covers });
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: signedCallbackHeaders(deps.secret, url, body, String(deps.nowSeconds()), deps.nonce()),
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[tools] cover push for ${label} -> ${res.status} sent=${covers.length}`);
      return [];
    }
    const stored = ((await res.json()) as { stored?: unknown }).stored;
    const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
    const line = `[tools] cover push for ${label} -> ${res.status} sent=${covers.length} stored=${ids.length}`;
    if (ids.length === 0) console.warn(`${line} stored_${Array.isArray(stored) ? 'empty' : 'missing'}`);
    else console.log(line);
    return ids;
  } catch (err) {
    console.warn(`[tools] cover push for ${label} failed: ${(err as Error).message} sent=${covers.length}`);
    return [];
  }
}

/** Downloads and pushes the covers; returns the ids the site stored ([] on any failure). */
export async function uploadCovers(handle: string, targets: readonly CoverTarget[], deps: CoverDeps): Promise<string[]> {
  if (!deps.secret) {
    console.warn(`[tools] covers for @${handle} skipped: no callback secret`);
    return [];
  }
  if (!targets.length) return [];
  const results = await Promise.all(targets.slice(0, MAX_COVERS).map((t) => download(t, deps)));
  const covers = results.flatMap((r) => (r.ok ? [r.cover] : []));
  const failed = rejections(results);
  console.log(`[tools] covers for @${handle}: targets=${results.length} downloaded=${covers.length}${failed ? ` rejected=${failed}` : ''}`);
  if (!covers.length) return [];
  return push(handle, covers, deps, `@${handle}`);
}

export interface AuthoredCoverTarget extends CoverTarget {
  /** The post's author; the site skips covers of removed creators. */
  author: string;
}

/**
 * Trends examples span many authors, so each cover carries its own handle and the push is batched by
 * MAX_COVERS (the site's per-request cap). Returns every id the site stored; a failed batch only loses itself.
 */
export async function uploadTrendCovers(targets: readonly AuthoredCoverTarget[], deps: CoverDeps): Promise<string[]> {
  if (!deps.secret) {
    if (targets.length) console.warn('[tools] trend covers skipped: no callback secret');
    return [];
  }
  if (!targets.length) return [];
  const stored: string[] = [];
  for (let i = 0; i < targets.length; i += MAX_COVERS) {
    const batch = targets.slice(i, i + MAX_COVERS);
    const results = await Promise.all(batch.map((t) => download(t, deps)));
    const covers = results.flatMap((r, j) => (r.ok ? [{ ...r.cover, handle: batch[j]!.author }] : []));
    const failed = rejections(results);
    console.log(`[tools] trend covers: targets=${results.length} downloaded=${covers.length}${failed ? ` rejected=${failed}` : ''}`);
    if (covers.length) stored.push(...(await push(null, covers, deps, 'trends')));
  }
  return stored;
}
