// ---------------------------------------------------------------------------
// TikTok Creative Center trending hashtags via Apify (slashloop.dev/tools).
//
// Apify was removed as a scraper in SLA-704; this is the one narrow, tools-only
// use that came back: a single pay-per-event actor run per day. The token is
// APIFY_API_KEY (host .env), sent as a Bearer header, never in a URL.
//
// Output rows are merged by the actor: one row per hashtag and period, with
// every rank the tag holds in `lists`. We flatten that to one record per
// (tag, list, period) and drop top_creators entirely (handles are personal data
// we do not need and must not forward).
// ---------------------------------------------------------------------------

const APIFY_API_BASE = 'https://api.apify.com/v2';
export const DEFAULT_TRENDS_ACTOR_ID = 'hyperbach/tiktok-creative-center-scraper';
/** Hard ceiling passed to Apify as maxTotalChargeUsd: the run stops charging here. */
export const TRENDS_MAX_CHARGE_USD = 0.25;
/** Cap on charged rows (US x 2 periods is ~92 distinct hashtags). */
export const TRENDS_MAX_ITEMS = 120;
const RUN_WAIT_SECONDS = 60;
const RUN_DEADLINE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 90_000;

export function trendsActorId(env: NodeJS.ProcessEnv = process.env): string {
  return env.APIFY_TRENDS_ACTOR_ID?.trim() || DEFAULT_TRENDS_ACTOR_ID;
}

export type TrendDirection = 'rising' | 'stable' | 'falling';

export interface TrendHashtag {
  tag: string;
  /** 'overall' or the Creative Center industry label of the list this rank is from. */
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
  /** Always null: the actor only returns a capped top-creators list, which we do not keep. */
  creators: null;
}

export class ApifyRunError extends Error {
  constructor(message: string, readonly costCents: number = 0) {
    super(message);
    this.name = 'ApifyRunError';
  }
}

export interface ApifyRunResult {
  runId: string;
  status: string;
  /** Billed cents, rounded up. */
  costCents: number;
  items: any[];
}

export interface ApifyDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const defaultApifyDeps: ApifyDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export function creativeCenterInput(periods: number[]): Record<string, unknown> {
  return {
    sections: ['hashtags'],
    hashtagCountries: ['US'],
    hashtagPeriods: periods.map(String),
    // Empty = the overall list plus all 15 industry lists, merged per hashtag.
    hashtagIndustries: [],
    maxItems: TRENDS_MAX_ITEMS,
  };
}

/** Run cost in cents: the larger of platform usage and pay-per-event charges. */
export function runCostCents(run: any): number {
  const usage = Number(run?.usageTotalUsd) || 0;
  const events = run?.pricingInfo?.pricingPerEvent?.actorChargeEvents ?? {};
  const counts = run?.chargedEventCounts ?? {};
  let charged = 0;
  for (const [name, n] of Object.entries(counts)) {
    charged += (Number(n) || 0) * (Number(events?.[name]?.eventPriceUsd) || 0);
  }
  const usd = Math.max(usage, charged);
  return usd > 0 ? Math.max(1, Math.ceil(usd * 100)) : 0;
}

async function apifyJson(deps: ApifyDeps, token: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await deps.fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new ApifyRunError(`apify ${res.status}`);
  return res.json();
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/** Start the actor, wait for it, read its dataset. Throws ApifyRunError carrying any billed cents. */
export async function runApifyActor(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  deps: ApifyDeps = defaultApifyDeps,
): Promise<ApifyRunResult> {
  const slug = encodeURIComponent(actorId.replace('/', '~'));
  const started = await apifyJson(
    deps, token,
    `${APIFY_API_BASE}/acts/${slug}/runs?waitForFinish=${RUN_WAIT_SECONDS}&maxTotalChargeUsd=${TRENDS_MAX_CHARGE_USD}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
  );
  let run = started?.data;
  if (!run?.id) throw new ApifyRunError('apify returned no run');
  const deadline = deps.now() + RUN_DEADLINE_MS;
  while (!TERMINAL.has(String(run.status)) && deps.now() < deadline) {
    await deps.sleep(1_000);
    run = (await apifyJson(deps, token, `${APIFY_API_BASE}/actor-runs/${run.id}?waitForFinish=${RUN_WAIT_SECONDS}`))?.data ?? run;
  }
  const costCents = runCostCents(run);
  if (run.status !== 'SUCCEEDED') {
    throw new ApifyRunError(`apify run ${String(run.status).toLowerCase()}`, costCents);
  }
  const items = await apifyJson(
    deps, token,
    `${APIFY_API_BASE}/datasets/${run.defaultDatasetId}/items?format=json&clean=true`,
  ).catch((err: Error) => {
    throw new ApifyRunError(err.message, costCents);
  });
  if (!Array.isArray(items)) throw new ApifyRunError('apify dataset was not a list', costCents);
  return { runId: String(run.id), status: String(run.status), costCents, items };
}

// --- mapping ------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

function direction(v: unknown): TrendDirection | null {
  if (v === 'up') return 'rising';
  if (v === 'down') return 'falling';
  if (v === 'flat') return 'stable';
  return null;
}

function scopeOf(list: unknown): string | null {
  const label = typeof list === 'string' ? list.trim() : '';
  if (!label) return null;
  return label.toLowerCase() === 'overall' ? 'overall' : label;
}

interface MergedTag {
  row: any;
  tag: string;
  period: number;
  lists: Array<{ scope: string; rank: number }>;
}

function bestRank(t: MergedTag, scope?: string): number {
  const ranks = t.lists.filter((l) => !scope || l.scope === scope).map((l) => l.rank);
  return ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
}

/**
 * Actor dataset -> one record per (tag, list, period). Rows that are errors,
 * labels or watched-but-unlisted tags are dropped. Throws when the actor says
 * it rejected the input.
 */
export function mapCreativeCenterItems(items: any[], periods: number[] = [7, 30]): TrendHashtag[] {
  if (items[0]?.error === true) {
    throw new ApifyRunError(`actor rejected input: ${String(items[0].code ?? 'unknown')}`);
  }
  const merged: MergedTag[] = [];
  for (const row of items) {
    const tag = typeof row?.hashtag_name === 'string' ? row.hashtag_name.replace(/^#/, '').trim().toLowerCase() : '';
    const period = Number(row?.period);
    if (!tag || !periods.includes(period)) continue;
    if (row?.row_type === 'not_listed' || String(row?.record_id ?? '').startsWith('not_listed')) continue;
    const rawLists = Array.isArray(row?.lists) && row.lists.length ? row.lists : [{ list: row?.list, rank: row?.rank }];
    const lists = rawLists
      .map((l: any) => ({ scope: scopeOf(l?.list), rank: Number(l?.rank) }))
      .filter((l: { scope: string | null; rank: number }): l is { scope: string; rank: number } =>
        l.scope !== null && Number.isFinite(l.rank) && l.rank >= 1);
    if (!lists.length) continue;
    merged.push({ row, tag, period, lists });
  }

  const out: TrendHashtag[] = [];
  for (const period of periods) {
    const ofPeriod = merged.filter((m) => m.period === period);
    const seen = new Set<string>();
    const unique = ofPeriod.filter((m) => (seen.has(m.tag) ? false : (seen.add(m.tag), true)));
    unique.sort((a, b) =>
      bestRank(a, 'overall') - bestRank(b, 'overall')
      || bestRank(a) - bestRank(b)
      || num(b.row.posts) - num(a.row.posts)
      || a.tag.localeCompare(b.tag));
    unique.forEach((m, i) => {
      const curve = Array.isArray(m.row.popularity_curve)
        ? m.row.popularity_curve.map((p: any) => num(p?.value))
        : [];
      const momentum = Number(m.row.trend_momentum_pct);
      const industries = Array.isArray(m.row.industries)
        ? m.row.industries.filter((x: unknown): x is string => typeof x === 'string')
        : [];
      for (const l of m.lists) {
        out.push({
          tag: m.tag,
          scope: l.scope,
          period,
          rank: l.rank,
          mergedRank: i + 1,
          posts: num(m.row.posts),
          views: num(m.row.views),
          curve,
          trendDirection: direction(m.row.trend_direction),
          momentumPct: m.row.trend_momentum_pct == null || !Number.isFinite(momentum) ? null : momentum,
          industries,
          creators: null,
        });
      }
    });
  }
  return out;
}
