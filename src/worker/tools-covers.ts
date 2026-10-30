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

async function download(target: CoverTarget, deps: CoverDeps): Promise<{ id: string; contentType: string; data: string } | null> {
  try {
    const res = await deps.fetch(target.url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!CONTENT_TYPES.has(contentType)) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_COVER_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
    return { id: target.id, contentType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

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
      console.warn(`[tools] cover push for ${label} -> ${res.status}`);
      return [];
    }
    const stored = ((await res.json()) as { stored?: unknown }).stored;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch (err) {
    console.warn(`[tools] cover push for ${label} failed: ${(err as Error).message}`);
    return [];
  }
}

/** Downloads and pushes the covers; returns the ids the site stored ([] on any failure). */
export async function uploadCovers(handle: string, targets: readonly CoverTarget[], deps: CoverDeps): Promise<string[]> {
  if (!targets.length || !deps.secret) return [];
  const covers = (await Promise.all(targets.slice(0, MAX_COVERS).map((t) => download(t, deps)))).filter((c) => c !== null);
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
  if (!targets.length || !deps.secret) return [];
  const stored: string[] = [];
  for (let i = 0; i < targets.length; i += MAX_COVERS) {
    const batch = targets.slice(i, i + MAX_COVERS);
    const downloaded = await Promise.all(batch.map((t) => download(t, deps)));
    const covers = downloaded.flatMap((c, j) => (c ? [{ ...c, handle: batch[j]!.author }] : []));
    if (covers.length) stored.push(...(await push(null, covers, deps, 'trends')));
  }
  return stored;
}
