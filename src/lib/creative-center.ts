// ---------------------------------------------------------------------------
// TikTok Creative Center trending hashtags (slashloop.dev/tools trends pages).
//
// The Creative Center web app reads its lists from an unsigned JSON endpoint;
// no login, cookie or signature is involved. Logged-out callers get at most
// the top 3 tags per list (`limit` is clamped, page 2 is empty), so the daily
// run reads the overall list plus one list per top-level industry, for each
// period. Sub-industry ids and GetHashtagDetail need a login and are not used.
//
// Per tag we keep rank, posts, views and the daily popularity curve. The
// `topCreators` block (handles, avatars) is personal data we do not need and
// is dropped here, never stored or forwarded.
// ---------------------------------------------------------------------------

import { proxyFetch } from './scrapers/proxy-http.js';

const LIST_URL = 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList';
/** Logged-out ceiling: the endpoint clamps `limit` to this. */
export const CC_LIST_LIMIT = 3;
/** ~1.9 KB measured on the wire per call; budgeted with headroom. */
export const CC_LIST_BYTES_ESTIMATE = 6 * 1024;
const LIST_MAX_BYTES = 256 * 1024;
const LIST_TIMEOUT_MS = 30_000;

/** Top-level Creative Center industries (the only ids that return data logged-out). */
export const CC_INDUSTRIES: ReadonlyArray<{ id: string; name: string }> = [
  { id: '10000000000', name: 'Education' },
  { id: '11000000000', name: 'Vehicle & Transportation' },
  { id: '12000000000', name: 'Baby, Kids & Maternity' },
  { id: '13000000000', name: 'Financial Services' },
  { id: '14000000000', name: 'Beauty & Personal Care' },
  { id: '15000000000', name: 'Tech & Electronics' },
  { id: '16000000000', name: 'Appliances' },
  { id: '17000000000', name: 'Travel' },
  { id: '18000000000', name: 'Household Products' },
  { id: '19000000000', name: 'Pets' },
  { id: '20000000000', name: 'Apps' },
  { id: '21000000000', name: 'Home Improvement' },
  { id: '22000000000', name: 'Apparel & Accessories' },
  { id: '23000000000', name: 'News & Entertainment' },
  { id: '24000000000', name: 'Business Services' },
  { id: '25000000000', name: 'Games' },
  { id: '26000000000', name: 'Life Services' },
  { id: '27000000000', name: 'Food & Beverage' },
  { id: '28000000000', name: 'Sports & Outdoor' },
  { id: '29000000000', name: 'Health' },
  { id: '30000000000', name: 'E-Commerce (Non-app)' },
];

const INDUSTRY_NAME = new Map(CC_INDUSTRIES.map((i) => [i.id, i.name]));

export type TrendDirection = 'rising' | 'stable' | 'falling';

export interface TrendHashtag {
  tag: string;
  /** 'overall' or the Creative Center industry name of the list this rank is from. */
  scope: string;
  period: number;
  /** 1-based rank inside `scope`. */
  rank: number;
  /** 1-based position of the tag in the merged list of its period (same on every scope row). */
  mergedRank: number;
  posts: number;
  views: number;
  /** TikTok's 0-100 popularity index per day, oldest first. */
  curve: number[];
  trendDirection: TrendDirection | null;
  momentumPct: number | null;
  industries: string[];
  /** Always null: logged-out Creative Center gives only a capped top-creators list, which we do not keep. */
  creators: null;
}

export class CreativeCenterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativeCenterError';
  }
}

export interface ListResponse {
  status: number;
  ok: boolean;
  text: string;
}

export type ListPoster = (url: string, body: string, headers: Record<string, string>) => Promise<ListResponse>;

export const proxyListPoster: ListPoster = async (url, body, headers) => {
  const r = await proxyFetch(url, { method: 'POST', body, headers, maxBytes: LIST_MAX_BYTES, timeoutMs: LIST_TIMEOUT_MS });
  return { status: r.status, ok: r.ok, text: r.text };
};

/** One list call. Returns the raw items; throws CreativeCenterError on a non-200 or a non-zero StatusCode. */
export async function fetchHashtagList(
  period: number,
  industryId: string | null,
  post: ListPoster = proxyListPoster,
): Promise<any[]> {
  const body = JSON.stringify({
    timeRange: period,
    countryCode: 'US',
    ...(industryId ? { industryID: industryId } : {}),
    page: 1,
    limit: CC_LIST_LIMIT,
  });
  const res = await post(LIST_URL, body, {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'agw-js-conv': 'str',
  });
  if (!res.ok) throw new CreativeCenterError(`creative center http ${res.status}`);
  let json: any;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new CreativeCenterError('creative center returned non-JSON');
  }
  const code = Number(json?.BaseResp?.StatusCode ?? 0);
  if (code !== 0) throw new CreativeCenterError(`creative center status ${code}`);
  return Array.isArray(json?.items) ? json.items : [];
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

function curveOf(item: any): number[] {
  return Array.isArray(item?.popularityCurve) ? item.popularityCurve.map((p: any) => num(p?.value)) : [];
}

/** Second-half average against first-half average of the curve; null when the first half is flat zero. */
export function curveMomentum(curve: number[]): { direction: TrendDirection | null; pct: number | null } {
  if (curve.length < 4) return { direction: null, pct: null };
  const mid = Math.floor(curve.length / 2);
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const before = avg(curve.slice(0, mid));
  const after = avg(curve.slice(curve.length - mid));
  if (before <= 0) return { direction: after > 0 ? 'rising' : 'stable', pct: null };
  const pct = Math.round(((after - before) / before) * 1000) / 10;
  return { direction: pct > 10 ? 'rising' : pct < -10 ? 'falling' : 'stable', pct };
}

export interface ListResult {
  period: number;
  /** 'overall' or an industry name. */
  scope: string;
  items: any[];
}

interface MergedTag {
  item: any;
  tag: string;
  lists: Array<{ scope: string; rank: number }>;
}

function bestRank(t: MergedTag, scope?: string): number {
  const ranks = t.lists.filter((l) => !scope || l.scope === scope).map((l) => l.rank);
  return ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
}

/** List results -> one record per (tag, list, period). */
export function mapHashtagLists(results: ListResult[], periods: number[]): TrendHashtag[] {
  const out: TrendHashtag[] = [];
  for (const period of periods) {
    const byTag = new Map<string, MergedTag>();
    for (const r of results) {
      if (r.period !== period) continue;
      r.items.forEach((item, i) => {
        const tag = typeof item?.hashtagName === 'string' ? item.hashtagName.replace(/^#/, '').trim().toLowerCase() : '';
        if (!tag) return;
        const rank = num(item?.rankIndex) || i + 1;
        const entry: MergedTag = byTag.get(tag) ?? { item, tag, lists: [] };
        entry.lists.push({ scope: r.scope, rank });
        byTag.set(tag, entry);
      });
    }
    const unique = [...byTag.values()].sort((a, b) =>
      bestRank(a, 'overall') - bestRank(b, 'overall')
      || bestRank(a) - bestRank(b)
      || num(b.item.publishCnt) - num(a.item.publishCnt)
      || a.tag.localeCompare(b.tag));
    unique.forEach((m, i) => {
      const curve = curveOf(m.item);
      const { direction, pct } = curveMomentum(curve);
      const industries = [...new Set<string>(
        (Array.isArray(m.item.industryIDs) ? m.item.industryIDs : [])
          .map((id: unknown) => INDUSTRY_NAME.get(String(id)))
          .filter((x: string | undefined): x is string => !!x)
          .concat(m.lists.map((l) => l.scope).filter((s) => s !== 'overall')),
      )];
      for (const l of m.lists) {
        out.push({
          tag: m.tag,
          scope: l.scope,
          period,
          rank: l.rank,
          mergedRank: i + 1,
          posts: num(m.item.publishCnt),
          views: num(m.item.vv),
          curve,
          trendDirection: direction,
          momentumPct: pct,
          industries,
          creators: null,
        });
      }
    });
  }
  return out;
}
