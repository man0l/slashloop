import { describe, expect, test } from "bun:test";
import worker, { type Env } from "../worker";
import { handleDnsbl, RATE_LIMIT_PER_HOUR } from "./dnsbl";

function memoryKv() {
  const store = new Map<string, string>();
  const puts: { key: string; ttl?: number }[] = [];
  return {
    store,
    puts,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
}

const listed = (async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.2" }] })) as unknown as typeof fetch;
const req = (path: string, headers: Record<string, string> = {}) => new Request(`https://slashloop.dev${path}`, { headers });

describe("GET /tools/api/geo", () => {
  test("returns cf fields, no-store, and flags a Contabo ASN as datacenter", async () => {
    const request = req("/tools/api/geo", { "cf-connecting-ip": "203.0.113.9" });
    Object.defineProperty(request, "cf", { value: { country: "DE", asn: 51167, asOrganization: "Contabo GmbH", colo: "FRA", isEUCountry: "1", continent: "EU" } });
    const res = await worker.fetch(request, { TOOLS_CACHE: memoryKv() } as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ip).toBe("203.0.113.9");
    expect(body.country).toBe("DE");
    expect(body.likelyDatacenter).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ["asOrganization", "asn", "city", "colo", "continent", "country", "ip", "isEUCountry", "likelyDatacenter", "postalCode", "region", "timezone"],
    );
  });

  test("POST is not routed", async () => {
    const res = await worker.fetch(new Request("https://slashloop.dev/tools/api/geo", { method: "POST" }), { TOOLS_CACHE: memoryKv() } as unknown as Env);
    expect(res.status).toBe(404);
  });
});

describe("GET /tools/api/dnsbl", () => {
  test("400 for non-IPv4 input, including IPv6", async () => {
    const kv = memoryKv();
    for (const q of ["ip=abc", "ip=2001:db8::1", "", "ip=1.2.3"]) {
      const res = await handleDnsbl(req(`/tools/api/dnsbl?${q}`), kv, listed);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("IPv4");
    }
    expect(kv.puts).toHaveLength(0);
  });

  test("returns listed results, caches 10 minutes under dnsbl:<ip>, then serves from cache", async () => {
    const kv = memoryKv();
    let calls = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => { calls++; return (listed as typeof fetch)(...args); }) as typeof fetch;
    const now = new Date("2026-10-25T14:05:00Z");
    const first = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.1" }), kv, counting, now);
    const body = (await first.json()) as { listedCount: number; results: { status: string }[] };
    expect(first.status).toBe(200);
    expect(body.results).toHaveLength(7);
    expect(body.listedCount).toBe(7);
    expect(calls).toBe(7);
    expect(kv.puts.find((p) => p.key === "dnsbl:127.0.0.2")?.ttl).toBe(600);

    const second = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.1" }), kv, counting, now);
    expect(second.status).toBe(200);
    expect(calls).toBe(7);
  });

  test("the 31st request in an hour from one client returns 429 with Retry-After", async () => {
    const kv = memoryKv();
    const now = new Date("2026-10-25T14:50:00Z");
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const res = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.1" }), kv, listed, now);
      expect(res.status).toBe(200);
    }
    expect(kv.store.has("rl:dnsbl:198.51.100.1:2026102514")).toBe(true);
    const blocked = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.1" }), kv, listed, now);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("600");

    const other = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.2" }), kv, listed, now);
    expect(other.status).toBe(200);

    const nextHour = await handleDnsbl(req("/tools/api/dnsbl?ip=127.0.0.2", { "cf-connecting-ip": "198.51.100.1" }), kv, listed, new Date("2026-10-25T15:00:01Z"));
    expect(nextHour.status).toBe(200);
  });
});
