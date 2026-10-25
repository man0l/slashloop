export type DnsblStatus = "listed" | "clean" | "unknown";

export type DnsblList = { zone: string; name: string; url: string };

// No Spamhaus zones: they refuse queries from public resolvers and return misleading answers.
export const DNSBL_LISTS: readonly DnsblList[] = [
  { zone: "bl.spamcop.net", name: "SpamCop", url: "https://www.spamcop.net/bl.shtml" },
  { zone: "b.barracudacentral.org", name: "Barracuda Reputation Block List", url: "https://www.barracudacentral.org/lookups" },
  { zone: "dnsbl.sorbs.net", name: "SORBS", url: "http://www.sorbs.net/lookup.shtml" },
  { zone: "dnsbl-1.uceprotect.net", name: "UCEPROTECT Level 1", url: "https://www.uceprotect.net/en/rblcheck.php" },
  { zone: "psbl.surriel.com", name: "Passive Spam Block List", url: "https://psbl.org/" },
  { zone: "all.s5h.net", name: "s5h.net", url: "https://www.usenix.org.uk/content/rbl.html" },
  { zone: "dnsbl.dronebl.org", name: "DroneBL", url: "https://dronebl.org/lookup" },
];

export function isValidIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export function reverseIPv4(ip: string): string {
  return ip.split(".").reverse().join(".");
}

type DohAnswer = { type?: number; data?: string };
export type DohResponse = { Status?: number; Answer?: DohAnswer[] };

// DoH JSON: Status 3 is NXDOMAIN (not listed); Status 0 with an A record in 127.0.0.0/8 is a listing.
export function classifyDoh(response: DohResponse | null | undefined): DnsblStatus {
  if (!response || typeof response.Status !== "number") return "unknown";
  if (response.Status === 3) return "clean";
  if (response.Status !== 0) return "unknown";
  const answers = (response.Answer ?? []).filter((a) => a.type === 1 && typeof a.data === "string");
  if (answers.some((a) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a.data as string))) return "listed";
  return answers.length === 0 ? "clean" : "unknown";
}

export type DnsblEntry = DnsblList & { status: DnsblStatus };

export async function lookupList(
  ip: string,
  list: DnsblList,
  doFetch: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<DnsblEntry> {
  const url = `https://cloudflare-dns.com/dns-query?name=${reverseIPv4(ip)}.${list.zone}&type=A`;
  try {
    const res = await doFetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ...list, status: "unknown" };
    return { ...list, status: classifyDoh((await res.json()) as DohResponse) };
  } catch {
    return { ...list, status: "unknown" };
  }
}

export function checkAllLists(ip: string, doFetch: typeof fetch = fetch, timeoutMs = 3000): Promise<DnsblEntry[]> {
  return Promise.all(DNSBL_LISTS.map((list) => lookupList(ip, list, doFetch, timeoutMs)));
}
