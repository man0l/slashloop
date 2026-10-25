import { describe, expect, test } from "bun:test";
import { buildGeo, isLikelyDatacenter } from "./geo";
import { HOSTING_ASNS } from "../data/hosting-asns";

describe("isLikelyDatacenter", () => {
  test("flags the seeded hosting ASNs", () => {
    for (const asn of [16509, 14618, 15169, 396982, 8075, 13335, 14061, 24940, 16276, 63949, 20473, 51167, 31898, 60781, 9009, 212238, 40021]) {
      expect(isLikelyDatacenter(asn)).toBe(true);
    }
    expect(HOSTING_ASNS.size).toBe(17);
  });

  test("does not flag consumer ISPs or a missing ASN", () => {
    expect(isLikelyDatacenter(7922)).toBe(false); // Comcast
    expect(isLikelyDatacenter(null)).toBe(false);
  });
});

describe("buildGeo", () => {
  test("maps request.cf fields and the datacenter flag", () => {
    const geo = buildGeo("203.0.113.9", {
      country: "DE", region: "Bavaria", city: "Nuremberg", postalCode: "90402", timezone: "Europe/Berlin",
      asn: 51167, asOrganization: "Contabo GmbH", colo: "FRA", isEUCountry: "1", continent: "EU",
    });
    expect(geo).toEqual({
      ip: "203.0.113.9", country: "DE", region: "Bavaria", city: "Nuremberg", postalCode: "90402",
      timezone: "Europe/Berlin", asn: 51167, asOrganization: "Contabo GmbH", colo: "FRA",
      isEUCountry: true, likelyDatacenter: true, continent: "EU",
    });
  });

  test("returns nulls and false flags when cf is missing", () => {
    const geo = buildGeo(null, undefined);
    expect(geo.ip).toBeNull();
    expect(geo.country).toBeNull();
    expect(geo.asn).toBeNull();
    expect(geo.isEUCountry).toBe(false);
    expect(geo.likelyDatacenter).toBe(false);
  });

  test("a residential ASN is not a datacenter", () => {
    expect(buildGeo("198.51.100.4", { country: "US", asn: 7922 }).likelyDatacenter).toBe(false);
  });
});
