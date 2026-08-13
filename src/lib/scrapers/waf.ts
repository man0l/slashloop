// ---------------------------------------------------------------------------
// TikTok web WAF challenge — ported from yt-dlp's TikTokBaseIE.
//
// The interstitial is a tiny HTML page ("Please wait...") with a SHA-256
// puzzle stuffed into element attributes. Solving it in process (no browser)
// sets `_wafchallengeid` so the next request gets the real page.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export interface WafCookie {
  name: string;
  value: string;
}

function attrOf(html: string, id: string, attr: string): string | null {
  const tag = html.match(new RegExp(`<(?:[^>]*\\s)?id=["']${id}["'][^>]*>`, 'i'))?.[0];
  if (!tag) return null;
  return tag.match(new RegExp(`${attr}=["']([^"']*)["']`, 'i'))?.[1] ?? null;
}

function b64Json(raw: string): any | null {
  try {
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isWafChallenge(html: string): boolean {
  if (!html) return false;
  if (/id=["']cs["']/i.test(html) && /id=["']wci["']/i.test(html)) return true;
  return html.includes('Please wait...') && html.length < 80_000;
}

/**
 * Brute-force the SHA-256 puzzle (yt-dlp walks 0..1_000_000). Returns the
 * cookies TikTok expects on the retry, or [] when the page is not a challenge.
 */
export function solveWafCookies(html: string): WafCookie[] {
  const csClass = attrOf(html, 'cs', 'class');
  if (!csClass) return [];
  const challenge = b64Json(csClass.endsWith('===') ? csClass : `${csClass}===`);
  if (!challenge?.v) return [];

  let expected: Buffer;
  let base: Buffer;
  try {
    expected = Buffer.from(String(challenge.v.c ?? ''), 'base64');
    base = Buffer.from(String(challenge.v.a ?? ''), 'base64');
  } catch {
    return [];
  }
  if (!expected.length || !base.length) return [];

  let found: string | null = null;
  for (let i = 0; i <= 1_000_000; i++) {
    const n = String(i);
    const digest = createHash('sha256').update(base).update(n).digest();
    if (digest.equals(expected)) {
      found = n;
      break;
    }
  }
  if (found == null) return [];

  challenge.d = Buffer.from(found).toString('base64');
  const wciName = attrOf(html, 'wci', 'class') ?? '_wafchallengeid';
  const cookies: WafCookie[] = [{
    name: wciName,
    value: Buffer.from(JSON.stringify(challenge)).toString('base64'),
  }];

  const rciName = attrOf(html, 'rci', 'class');
  const rciValue = attrOf(html, 'rs', 'class');
  if (rciName && rciValue) cookies.push({ name: rciName, value: rciValue });
  return cookies;
}
