import { checkAllLists, isValidIPv4, type DnsblEntry } from "../calc/dnsbl";

export const RATE_LIMIT_PER_HOUR = 30;
export const RESULT_TTL_SECONDS = 600;

export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

function hourKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}`;
}

// KV is not atomic, so concurrent bursts can slip a few extra requests past the cap. That is fine for abuse control.
async function overLimit(kv: Kv, clientIp: string, now: Date): Promise<number | null> {
  const key = `rl:dnsbl:${clientIp}:${hourKey(now)}`;
  const count = Number((await kv.get(key)) ?? 0) || 0;
  if (count >= RATE_LIMIT_PER_HOUR) {
    return Math.max(1, 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds()));
  }
  await kv.put(key, String(count + 1), { expirationTtl: 3700 });
  return null;
}

export type DnsblPayload = { ip: string; checkedAt: string; listedCount: number; results: DnsblEntry[] };

export async function handleDnsbl(
  request: Request,
  kv: Kv,
  doFetch: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<Response> {
  const ip = (new URL(request.url).searchParams.get("ip") ?? "").trim();
  if (!isValidIPv4(ip)) {
    return json({ error: "Enter a valid IPv4 address such as 203.0.113.7. IPv6 is not supported yet." }, 400);
  }

  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const retryAfter = await overLimit(kv, clientIp, now);
  if (retryAfter !== null) {
    return json({ error: "Rate limit reached: 30 checks per hour. Try again later." }, 429, { "retry-after": String(retryAfter) });
  }

  const cacheKey = `dnsbl:${ip}`;
  const cached = await kv.get(cacheKey);
  if (cached) return new Response(cached, { headers: HEADERS });

  const results = await checkAllLists(ip, doFetch);
  const payload: DnsblPayload = {
    ip,
    checkedAt: now.toISOString(),
    listedCount: results.filter((r) => r.status === "listed").length,
    results,
  };
  const body = JSON.stringify(payload);
  await kv.put(cacheKey, body, { expirationTtl: RESULT_TTL_SECONDS });
  return new Response(body, { headers: HEADERS });
}
