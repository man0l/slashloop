// ---------------------------------------------------------------------------
// TikTok web URL signing (X-Bogus).
//
// Unsigned /api/challenge/item_list and /api/search/* return HTTP 200 / 0
// bytes. Appending X-Bogus — the same parameter TikTok's own web app adds —
// is what made the hashtag latest feed answer with a real itemList (checked
// live 2026-08-13 against #mewing / challengeID 1362460).
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type SignFn = (url: string, userAgent: string) => string;

let impl: SignFn | null | undefined;

function load(): SignFn | null {
  if (impl !== undefined) return impl;
  try {
    const mod = require('xbogus');
    const fn = typeof mod === 'function' ? mod : mod?.default;
    impl = typeof fn === 'function' ? fn : null;
  } catch {
    impl = null;
  }
  return impl ?? null;
}

/** Append X-Bogus. Returns the original URL when the signer is missing. */
export function signTikTokUrl(url: string, userAgent: string): string {
  if (!url.includes('tiktok.com/api/')) return url;
  if (/[?&]X-Bogus=/.test(url)) return url;
  const sign = load();
  if (!sign) return url;
  try {
    const token = sign(url, userAgent);
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}X-Bogus=${token}`;
  } catch {
    return url;
  }
}
