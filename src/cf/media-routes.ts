// GET /thumbs/{path} — public cover images from the thumbs R2 binding.
// GET /media/{path}?t=… — private MP4s/slides from the media binding, JWT-gated.
//
// These routes only exist on the Workers runtime (binding-backed storage,
// src/lib/storage.ts 'r2-binding'). Media URLs are minted by signUrl() as
// short-lived JWTs (src/lib/media-url.ts) that authorise exactly one object
// path — same trust model as the /gallery link. Thumbs are public data, so
// that route is open but served with immutable cache-control for edge caching.
//
// Range requests matter on /media: <video> seeking on Safari/iOS sends
// `Range: bytes=…`, and a server without 206 support breaks playback.

import { verifyMediaToken } from '../lib/media-url.js';
import { getR2Bindings } from '../lib/storage-bindings.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

/** Reject path traversal / absolute keys. R2 keys are flat strings; be strict. */
function safeKey(raw: string): string | null {
  if (!raw || raw.includes('..') || raw.startsWith('/') || raw.includes('\\')) return null;
  return raw;
}

/** bytes=start-end (end optional) or bytes=-N (suffix). Null when absent/broken. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (!Number.isFinite(start) || start >= size) return null;
    end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!Number.isFinite(end) || end < start) return null;
  }
  return { start, end };
}

export async function GET(request: Request): Promise<Response> {
  const bindings = getR2Bindings();
  if (!bindings) return notFound();

  const url = new URL(request.url);
  const isMedia = url.pathname.startsWith('/media/');
  const key = safeKey(decodeURIComponent(url.pathname.replace(/^\/(thumbs|media)\//, '')));
  if (!key) return notFound();

  if (isMedia) {
    // The JWT authorises exactly this object path.
    const authorised = await verifyMediaToken(url.searchParams.get('t'));
    if (!authorised || authorised !== key) {
      return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }

  const bucket = isMedia ? bindings.media : bindings.thumbs;

  // Size probe so malformed/overlong ranges can fall back to a plain 200 —
  // and so Content-Range can carry the FULL object size.
  let fullSize: number | null = null;
  let range: { start: number; end: number } | null = null;
  if (isMedia && request.headers.get('range')) {
    const head = await bucket.head(key);
    if (!head) return notFound();
    fullSize = head.size;
    range = parseRange(request.headers.get('range'), head.size);
  }

  const obj = await bucket.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) return notFound();

  const headers = new Headers();
  headers.set('Content-Type', contentTypeFor(key));
  headers.set('Accept-Ranges', 'bytes');
  if (isMedia) {
    // Private: the token IS the capability — never cache on shared proxies.
    headers.set('Cache-Control', 'private, max-age=3600');
    if (range && fullSize !== null) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${fullSize}`);
      return new Response(obj.body, { status: 206, headers });
    }
  } else {
    headers.set('Cache-Control', IMMUTABLE);
  }

  return new Response(obj.body, { status: 200, headers });
}
