import { HOSTING_ASNS } from "../data/hosting-asns";

export type GeoResult = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  timezone: string | null;
  asn: number | null;
  asOrganization: string | null;
  colo: string | null;
  isEUCountry: boolean;
  likelyDatacenter: boolean;
  continent: string | null;
};

type CfLike = Partial<Record<string, unknown>> | undefined;

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function isLikelyDatacenter(asn: number | null): boolean {
  return asn !== null && HOSTING_ASNS.has(asn);
}

export function buildGeo(ip: string | null, cf: CfLike): GeoResult {
  const rawAsn = Number(cf?.asn);
  const asn = Number.isInteger(rawAsn) && rawAsn > 0 ? rawAsn : null;
  return {
    ip: str(ip),
    country: str(cf?.country),
    region: str(cf?.region),
    city: str(cf?.city),
    postalCode: str(cf?.postalCode),
    timezone: str(cf?.timezone),
    asn,
    asOrganization: str(cf?.asOrganization),
    colo: str(cf?.colo),
    isEUCountry: cf?.isEUCountry === "1" || cf?.isEUCountry === 1 || cf?.isEUCountry === true,
    likelyDatacenter: isLikelyDatacenter(asn),
    continent: str(cf?.continent),
  };
}
