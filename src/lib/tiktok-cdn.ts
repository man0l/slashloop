/**
 * TikTok's own media CDNs 403 datacenter IPs and hotlinked browser
 * requests (Referer / origin gate). Never hand these URLs to an <img>
 * or <video>, and never fetch them from our servers without the spoofed
 * headers in media.ts.
 *
 * Regional image hosts (`tiktokcdn-us.com`, `tiktokcdn-eu.com`, …) are
 * the ones the gallery actually sees — a `tiktokcdn.com`-only check
 * misses them and the UI hotlinks a URL that 403s.
 */
export function isTikTokCdnUrl(url: string): boolean {
  if (!url) return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return /tiktokcdn/i.test(url);
  }
  return (
    /(^|\.)tiktokcdn([.-][a-z0-9]+)*\.com$/.test(host)
    || /(^|\.)tiktok\.com$/.test(host)
    || /(^|\.)tiktokv\.com$/.test(host)
    || /(^|\.)tik-tok\.com$/.test(host)
    || /(^|\.)ibyteimg\.com$/.test(host)
  );
}
