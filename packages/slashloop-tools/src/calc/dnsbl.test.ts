import { describe, expect, test } from "bun:test";
import { checkAllLists, classifyDoh, DNSBL_LISTS, isValidIPv4, reverseIPv4 } from "./dnsbl";

describe("isValidIPv4", () => {
  test("accepts dotted quads", () => {
    for (const ip of ["1.2.3.4", "127.0.0.2", "255.255.255.255", "0.0.0.0"]) expect(isValidIPv4(ip)).toBe(true);
  });
  test("rejects everything else", () => {
    for (const ip of ["abc", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.-4", "::1", "2001:db8::1", "1.2.3.4 ", "1.2.3.4/24"]) {
      expect(isValidIPv4(ip)).toBe(false);
    }
  });
});

describe("reverseIPv4", () => {
  test("reverses octets", () => {
    expect(reverseIPv4("1.2.3.4")).toBe("4.3.2.1");
    expect(reverseIPv4("127.0.0.2")).toBe("2.0.0.127");
  });
});

describe("classifyDoh", () => {
  test("A record in 127/8 is listed", () => {
    expect(classifyDoh({ Status: 0, Answer: [{ type: 1, data: "127.0.0.2" }] })).toBe("listed");
    expect(classifyDoh({ Status: 0, Answer: [{ type: 1, data: "127.0.0.11" }] })).toBe("listed");
  });
  test("NXDOMAIN and empty NOERROR are clean", () => {
    expect(classifyDoh({ Status: 3 })).toBe("clean");
    expect(classifyDoh({ Status: 0 })).toBe("clean");
    expect(classifyDoh({ Status: 0, Answer: [{ type: 5, data: "x.example." }] })).toBe("clean");
  });
  test("SERVFAIL, malformed and non-127 answers are unknown", () => {
    expect(classifyDoh({ Status: 2 })).toBe("unknown");
    expect(classifyDoh(null)).toBe("unknown");
    expect(classifyDoh({} as never)).toBe("unknown");
    expect(classifyDoh({ Status: 0, Answer: [{ type: 1, data: "203.0.113.5" }] })).toBe("unknown");
  });
});

describe("checkAllLists", () => {
  test("maps mocked DoH responses to listed / clean / unknown per zone", async () => {
    const seen: string[] = [];
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url.searchParams.get("name") as string);
      expect((init?.headers as Record<string, string>).accept).toBe("application/dns-json");
      expect(url.origin + url.pathname).toBe("https://cloudflare-dns.com/dns-query");
      expect(url.searchParams.get("type")).toBe("A");
      const name = url.searchParams.get("name") as string;
      if (name.endsWith("bl.spamcop.net")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.2" }] });
      if (name.endsWith("psbl.surriel.com")) throw new DOMException("timed out", "TimeoutError");
      if (name.endsWith("all.s5h.net")) return new Response("bad", { status: 502 });
      return Response.json({ Status: 3 });
    }) as typeof fetch;

    const results = await checkAllLists("1.2.3.4", mock);
    expect(results).toHaveLength(7);
    expect(seen.every((n) => n.startsWith("4.3.2.1."))).toBe(true);
    const byZone = Object.fromEntries(results.map((r) => [r.zone, r.status]));
    expect(byZone["bl.spamcop.net"]).toBe("listed");
    expect(byZone["psbl.surriel.com"]).toBe("unknown");
    expect(byZone["all.s5h.net"]).toBe("unknown");
    expect(byZone["b.barracudacentral.org"]).toBe("clean");
  });

  test("never queries Spamhaus zones", () => {
    expect(DNSBL_LISTS.some((l) => l.zone.includes("spamhaus"))).toBe(false);
    expect(DNSBL_LISTS.map((l) => l.zone)).toEqual([
      "bl.spamcop.net", "b.barracudacentral.org", "dnsbl.sorbs.net", "dnsbl-1.uceprotect.net",
      "psbl.surriel.com", "all.s5h.net", "dnsbl.dronebl.org",
    ]);
  });
});
