// ASNs of large hosting and cloud providers. Used only as a heuristic for "likely datacenter IP".
// To extend: add the numeric ASN with a short provider comment (look it up at bgp.he.net), keep the list
// to networks that mostly serve servers rather than consumers, and add a case to src/calc/geo.test.ts.
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  16509, // Amazon (AWS)
  14618, // Amazon (AWS)
  15169, // Google
  396982, // Google Cloud
  8075, // Microsoft (Azure)
  13335, // Cloudflare
  14061, // DigitalOcean
  24940, // Hetzner
  16276, // OVH
  63949, // Linode (Akamai Connected Cloud)
  20473, // Vultr
  51167, // Contabo GmbH
  40021, // Contabo Inc (US)
  31898, // Oracle Cloud
  60781, // Leaseweb
  9009, // M247
  212238, // Datacamp (CDN77)
]);
