// SSRF guard for customer-supplied webhook URLs (SLA-617). Pure and
// runtime-neutral: the Worker validates at create time (literal checks only,
// no DNS available), the VPS deliverer re-checks every resolved address
// immediately before connecting.
import { isIP } from 'node:net';

export class WebhookUrlError extends Error {
  constructor(public code: string, message = code) { super(message); }
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.private'];

const v4 = (ip: string): number[] | null => {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const n = p.map(Number);
  return n.every((x, i) => Number.isInteger(x) && x >= 0 && x <= 255 && String(x) === p[i]) ? n : null;
};

function privateV4(ip: string): boolean {
  const o = v4(ip);
  if (!o) return true;
  const [a, b, c] = o as [number, number, number, number];
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

/** Expands an IPv6 literal into eight 16-bit groups, or null when malformed. */
function groupsV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const tail = s.lastIndexOf(':');
  if (s.includes('.')) {
    const o = v4(s.slice(tail + 1));
    if (!o) return null;
    s = `${s.slice(0, tail + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill('0'), ...rest].map(g => parseInt(g, 16));
  return all.length === 8 && all.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function privateV6(ip: string): boolean {
  const g = groupsV6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every(x => x === 0) || (g.slice(0, 7).every(x => x === 0) && g7 === 1)) return true; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true; // ULA, link-local, multicast
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return privateV4(embeddedV4(g6, g7)); // ::ffff:a.b.c.d and ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return privateV4(embeddedV4(g6, g7)); // NAT64
  if (g0 === 0x2002) return privateV4(embeddedV4(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  return false;
}

/** True when an address is loopback, private, link-local, multicast, reserved or malformed. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare);
  if (kind === 4) return privateV4(bare);
  if (kind === 6) return privateV6(bare);
  return true;
}

/**
 * https only, port 443, no credentials, and no host that is obviously internal.
 * WHATWG URL parsing already folds decimal/octal/hex IPv4 spellings into dotted
 * quads, so `https://2130706433/` is seen as 127.0.0.1 here.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new WebhookUrlError('invalid_url', 'notify.url is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new WebhookUrlError('url_not_https', 'notify.url must use https.');
  if (u.username || u.password) throw new WebhookUrlError('url_has_credentials', 'notify.url must not embed credentials.');
  if (u.port && u.port !== '443') throw new WebhookUrlError('url_port_not_allowed', 'notify.url must use the default https port (443).');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new WebhookUrlError('invalid_url', 'notify.url has no host.');
  const literal = host.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) throw new WebhookUrlError('url_host_not_public', 'notify.url must point at a public host.');
    return u;
  }
  if (host === 'localhost' || !host.includes('.') || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) {
    throw new WebhookUrlError('url_host_not_public', 'notify.url must point at a public host.');
  }
  return u;
}
