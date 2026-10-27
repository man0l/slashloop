// TikTok video-link normalisation for the public transcript tool (SLA-1057).
// Pure parsing plus a bounded short-link resolver; every hop stays on a tiktok.com host.

export interface VideoRef {
  videoId: string;
  /** https://www.tiktok.com/@user/video/<id> */
  url: string;
}

export type VideoLinkParse =
  | { kind: 'video'; ref: VideoRef }
  | { kind: 'short'; url: string }
  | { kind: 'photo' }
  | { kind: 'invalid' };

const MAIN_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const VIDEO_PATH = /^\/@([A-Za-z0-9._]{1,48})\/video\/(\d{8,25})\/?$/;
const PHOTO_PATH = /^\/@[A-Za-z0-9._]{1,48}\/photo\/\d{8,25}\/?$/;
const SHORT_PATH = /^\/([A-Za-z0-9_-]{4,40})\/?$/;
const TSHORT_PATH = /^\/t\/([A-Za-z0-9_-]{4,40})\/?$/;
const MAX_HOPS = 3;

/** Classifies a pasted link. Never fetches. */
export function parseVideoLink(input: unknown): VideoLinkParse {
  if (typeof input !== 'string') return { kind: 'invalid' };
  const raw = input.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return { kind: 'invalid' };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { kind: 'invalid' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'invalid' };
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return { kind: 'invalid' };
  const host = u.hostname.toLowerCase();
  if (MAIN_HOSTS.has(host)) {
    const video = VIDEO_PATH.exec(u.pathname);
    if (video) return { kind: 'video', ref: { videoId: video[2], url: `https://www.tiktok.com/@${video[1]}/video/${video[2]}` } };
    if (PHOTO_PATH.test(u.pathname)) return { kind: 'photo' };
    const t = TSHORT_PATH.exec(u.pathname);
    if (t) return { kind: 'short', url: `https://www.tiktok.com/t/${t[1]}/` };
    return { kind: 'invalid' };
  }
  if (SHORT_HOSTS.has(host)) {
    const code = SHORT_PATH.exec(u.pathname);
    if (code) return { kind: 'short', url: `https://${host}/${code[1]}/` };
  }
  return { kind: 'invalid' };
}

/**
 * Follows a short link with HEAD + manual redirects (reading Location only, never the body).
 * Returns null when it does not land on a canonical video URL within a few tiktok.com hops.
 */
export async function resolveShortLink(
  start: string,
  fetchImpl: typeof fetch,
): Promise<VideoRef | { photo: true } | null> {
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    } catch {
      return null;
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return null;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return null;
    }
    const parsed = parseVideoLink(next);
    if (parsed.kind === 'video') return parsed.ref;
    if (parsed.kind === 'photo') return { photo: true };
    if (parsed.kind !== 'short') return null;
    current = parsed.url;
  }
  return null;
}

export interface VideoPreview {
  title: string;
  author: string;
  thumbnailUrl: string | null;
}

export type OembedOutcome = { ok: true; preview: VideoPreview } | { ok: false; notFound: boolean };

/** Validates a video via TikTok oEmbed. 4xx means the video is gone or private; anything else is treated as a soft failure. */
export async function fetchOembed(url: string, fetchImpl: typeof fetch): Promise<OembedOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    });
  } catch {
    return { ok: false, notFound: false };
  }
  if (res.status === 404 || res.status === 400) return { ok: false, notFound: true };
  if (!res.ok) return { ok: false, notFound: false };
  try {
    const data = (await res.json()) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
    const thumb = typeof data.thumbnail_url === 'string' && /^https:\/\//.test(data.thumbnail_url) ? data.thumbnail_url : null;
    return {
      ok: true,
      preview: {
        title: typeof data.title === 'string' ? data.title.slice(0, 500) : '',
        author: typeof data.author_name === 'string' ? data.author_name.slice(0, 100) : '',
        thumbnailUrl: thumb,
      },
    };
  } catch {
    return { ok: false, notFound: false };
  }
}
