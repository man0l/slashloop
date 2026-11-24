// Account stats chart (SLA-1439): views per account over time, from the daily
// snapshots in social_post_metrics_daily (migration 0031).
//
//   gained — per post, each day's views minus the previous snapshot's, clamped
//            at 0. A post's FIRST snapshot is a baseline (0) unless the post
//            was published that same UTC day, when it counts in full.
//   posted — views as of now, attributed to each post's publish day.
//   age    — the gained series re-stacked by the post's age on the day of the
//            gain (AGE_BANDS). Posts with no snapshot on their publish day have
//            no trustworthy age, so they land in `unattributed` — still in the
//            totals, out of the bands.
//
// Everything is UTC; the read is shared by GET /api/social/stats and the
// get_social_stats MCP tool.

import { rawBatch, type RawStatement } from '../store.js';
import { laneAndPrimary, parseStoredTags } from './rotation.js';
import { visibleIntegrations } from './posting.js';

export const STATS_BUCKETS = ['day', 'week', 'month'] as const;
export const STATS_MODES = ['gained', 'posted', 'age'] as const;
export const AGE_BANDS = ['0-24h', '24-48h', '48-72h', '3-7d', '7d+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export type StatsBucket = (typeof STATS_BUCKETS)[number];
export type StatsMode = (typeof STATS_MODES)[number];

export const MAX_STATS_DAYS = 400;
const MAX_ACCOUNT_FILTER = 50;
const CARRY_FORWARD_LIMIT = 500;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatsQuery {
  from: string;
  to: string;
  bucket: StatsBucket;
  mode: StatsMode;
  /** Integration ids; undefined = every account the caller can see. */
  accounts?: string[];
}

export interface StatsAccount {
  id: string;
  provider: string;
  profile: string | null;
  name: string | null;
  lane: string | null;
}

export interface StatsResult {
  mode: StatsMode;
  bucket: StatsBucket;
  trackingSince: string | null;
  accounts: StatsAccount[];
  buckets: Array<{
    start: string;
    byAccount: Record<string, number>;
    /** mode=age only: gained views by post age; bands + unattributed = sum(byAccount). */
    byAge?: Record<AgeBand | 'unattributed', number>;
  }>;
}

export interface DayPost {
  postId: string;
  integrationId: string;
  caption: string | null;
  /** Unix seconds (UTC instant) so the site can render local time. */
  publishedAt: number | null;
  gained: number;
  /** Age on `day`; null when the post has no publish-day snapshot. */
  ageBand: AgeBand | null;
}

export interface DayResult {
  day: string;
  total: number;
  accounts: StatsAccount[];
  /** Gained views by post age; bands + unattributed = total. */
  byAge: Record<AgeBand | 'unattributed', number>;
  posts: DayPost[];
  /** True when more posts gained views than `posts` carries. */
  truncated: boolean;
}

// ── day math (UTC) ──────────────────────────────────────────────────────────

const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function isRealDay(day: string): boolean {
  const ms = dayToMs(day);
  return DAY_RE.test(day) && Number.isFinite(ms) && msToDay(ms) === day;
}

/** First day of the bucket containing `day`: itself, the Monday of its week, or the 1st of its month. */
export function bucketStart(day: string, bucket: StatsBucket): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return `${day.slice(0, 7)}-01`;
  const ms = dayToMs(day);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return msToDay(ms - sinceMonday * DAY_MS);
}

function nextBucketStart(start: string, bucket: StatsBucket): string {
  if (bucket === 'day') return msToDay(dayToMs(start) + DAY_MS);
  if (bucket === 'week') return msToDay(dayToMs(start) + 7 * DAY_MS);
  const d = new Date(dayToMs(start));
  return msToDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Every bucket start covering from..to, so the chart axis has no holes. */
export function bucketStarts(from: string, to: string, bucket: StatsBucket): string[] {
  const out: string[] = [];
  for (let s = bucketStart(from, bucket); s <= to; s = nextBucketStart(s, bucket)) out.push(s);
  return out;
}

// ── params ──────────────────────────────────────────────────────────────────

export type ParsedStatsQuery = { ok: true; query: StatsQuery } | { ok: false; error: string; message: string };

const bad = (error: string, message: string): ParsedStatsQuery => ({ ok: false, error, message });

/** Defaults: the last 30 days (UTC), per day, gained, every account. */
export function parseStatsQuery(
  input: { from?: string | null; to?: string | null; bucket?: string | null; mode?: string | null; accounts?: string | null },
  nowMs: number = Date.now(),
): ParsedStatsQuery {
  const to = input.to || msToDay(nowMs);
  const from = input.from || msToDay(dayToMs(to) - 29 * DAY_MS);
  if (!isRealDay(from) || !isRealDay(to)) return bad('invalid_range', 'from and to must be YYYY-MM-DD dates.');
  if (to < from) return bad('invalid_range', '`to` must not be before `from`.');
  if ((dayToMs(to) - dayToMs(from)) / DAY_MS + 1 > MAX_STATS_DAYS) {
    return bad('range_too_large', `The range may span at most ${MAX_STATS_DAYS} days.`);
  }
  const bucket = input.bucket || 'day';
  if (!(STATS_BUCKETS as readonly string[]).includes(bucket)) return bad('invalid_bucket', 'bucket must be day, week or month.');
  const mode = input.mode || 'gained';
  if (!(STATS_MODES as readonly string[]).includes(mode)) return bad('invalid_mode', 'mode must be gained, posted or age.');
  const accounts = input.accounts
    ? [...new Set(input.accounts.split(',').map((a) => a.trim()).filter(Boolean))]
    : undefined;
  if (accounts && accounts.length > MAX_ACCOUNT_FILTER) return bad('too_many_accounts', `Filter by at most ${MAX_ACCOUNT_FILTER} accounts.`);
  return { ok: true, query: { from, to, bucket: bucket as StatsBucket, mode: mode as StatsMode, accounts } };
}

// ── read ────────────────────────────────────────────────────────────────────

interface DayRow {
  day: string;
  integration_id: string;
  views: number | null;
}

const placeholders = (from: number, n: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(', ');

/** CASE mapping an age in whole UTC days to a band. */
const BAND_SQL = `CASE
                WHEN age_days IS NULL OR NOT has_pub THEN NULL
                WHEN age_days < 1 THEN '0-24h'
                WHEN age_days < 2 THEN '24-48h'
                WHEN age_days < 3 THEN '48-72h'
                WHEN age_days < 7 THEN '3-7d'
                ELSE '7d+'
              END`;

/** One row per (post, day) with its gain and age. Window functions run over
 *  each post's whole history (the delta at the range's first day needs the
 *  snapshot before it); the caller filters the range afterwards. */
const deltaCte = (ownerList: string, integrationList: string) => `
  SELECT m.post_id AS post_id, m.day AS day, p.integration_id AS integration_id,
    CASE
      WHEN LAG(m.views) OVER w IS NULL
        THEN CASE WHEN date(p.published_at, 'unixepoch') = m.day THEN m.views ELSE 0 END
      ELSE MAX(m.views - LAG(m.views) OVER w, 0)
    END AS delta,
    CAST(julianday(m.day) - julianday(date(p.published_at, 'unixepoch')) AS INTEGER) AS age_days,
    EXISTS (SELECT 1 FROM social_post_metrics_daily f WHERE f.post_id = m.post_id AND f.day = date(p.published_at, 'unixepoch')) AS has_pub
  FROM social_post_metrics_daily m
  JOIN social_posts p ON p.id = m.post_id
  WHERE p.owner_id IN (${ownerList}) AND p.integration_id IN (${integrationList}) AND m.views IS NOT NULL
  WINDOW w AS (PARTITION BY m.post_id ORDER BY m.day)`;

function gainedStatement(owners: string[], integrationIds: string[], from: string, to: string): RawStatement {
  const ownerList = placeholders(3, owners.length);
  const integrationList = placeholders(3 + owners.length, integrationIds.length);
  return {
    sql: `SELECT day, integration_id, SUM(delta) AS views FROM (${deltaCte(ownerList, integrationList)})
          WHERE day >= ?1 AND day <= ?2
          GROUP BY day, integration_id`,
    params: [from, to, ...owners, ...integrationIds],
  };
}

/** Same gain as gainedStatement, split by post age band (NULL band = unattributed). */
function ageStatement(owners: string[], integrationIds: string[], from: string, to: string): RawStatement {
  const ownerList = placeholders(3, owners.length);
  const integrationList = placeholders(3 + owners.length, integrationIds.length);
  return {
    sql: `SELECT day, ${BAND_SQL} AS band, SUM(delta) AS views FROM (${deltaCte(ownerList, integrationList)})
          WHERE day >= ?1 AND day <= ?2
          GROUP BY 1, 2`,
    params: [from, to, ...owners, ...integrationIds],
  };
}

function postedStatement(owners: string[], integrationIds: string[], from: string, to: string): RawStatement {
  const ownerList = placeholders(3, owners.length);
  const integrationList = placeholders(3 + owners.length, integrationIds.length);
  return {
    sql: `SELECT date(published_at, 'unixepoch') AS day, integration_id, SUM(views) AS views
          FROM social_posts
          WHERE state = 'PUBLISHED' AND published_at IS NOT NULL AND owner_id IN (${ownerList}) AND integration_id IN (${integrationList})
            AND date(published_at, 'unixepoch') >= ?1 AND date(published_at, 'unixepoch') <= ?2
          GROUP BY 1, 2`,
    params: [from, to, ...owners, ...integrationIds],
  };
}

export async function getSocialStats(owners: string[], query: StatsQuery): Promise<StatsResult> {
  const visible = await visibleIntegrations(owners, false);
  const wanted = query.accounts ? new Set(query.accounts) : null;
  const accounts: StatsAccount[] = visible
    .filter((row) => !wanted || wanted.has(row.id))
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      profile: row.profile ?? null,
      name: row.name ?? null,
      lane: laneAndPrimary(parseStoredTags(row.tags)).lane,
    }));

  const starts = bucketStarts(query.from, query.to, query.bucket);
  const byStart = new Map(starts.map((s) => [s, Object.fromEntries(accounts.map((a) => [a.id, 0])) as Record<string, number>]));
  const ids = accounts.map((a) => a.id);
  const byAge = new Map(starts.map((s) => [s, emptyAge()]));

  let trackingSince: string | null = null;
  if (owners.length && ids.length) {
    const statements: RawStatement[] = [
      query.mode === 'posted' ? postedStatement(owners, ids, query.from, query.to) : gainedStatement(owners, ids, query.from, query.to),
      ...(query.mode === 'age' ? [ageStatement(owners, ids, query.from, query.to)] : []),
      {
        sql: `SELECT MIN(m.day) AS day FROM social_post_metrics_daily m JOIN social_posts p ON p.id = m.post_id
              WHERE p.owner_id IN (${placeholders(1, owners.length)})`,
        params: owners,
      },
    ];
    const results = await rawBatch(statements);
    const [data] = results;
    const since = results[results.length - 1];
    for (const r of (data ?? []) as DayRow[]) {
      const slot = byStart.get(bucketStart(r.day, query.bucket));
      if (slot && r.integration_id in slot) slot[r.integration_id]! += r.views ?? 0;
    }
    if (query.mode === 'age') {
      for (const r of (results[1] ?? []) as Array<{ day: string; band: AgeBand | null; views: number | null }>) {
        const slot = byAge.get(bucketStart(r.day, query.bucket));
        if (slot) slot[r.band ?? 'unattributed'] += r.views ?? 0;
      }
    }
    trackingSince = ((since?.[0] as { day: string | null } | undefined)?.day) ?? null;
  }

  return {
    mode: query.mode,
    bucket: query.bucket,
    trackingSince,
    accounts,
    buckets: starts.map((start) => ({ start, byAccount: byStart.get(start)!, ...(query.mode === 'age' ? { byAge: byAge.get(start)! } : {}) })),
  };
}

const emptyAge = (): Record<AgeBand | 'unattributed', number> => ({ '0-24h': 0, '24-48h': 0, '48-72h': 0, '3-7d': 0, '7d+': 0, unattributed: 0 });

// ── one day, per post ───────────────────────────────────────────────────────

export const MAX_DAY_POSTS = 200;
const CAPTION_MAX = 300;

export function parseDayQuery(input: { day?: string | null; accounts?: string | null }): { ok: true; day: string; accounts?: string[] } | { ok: false; error: string; message: string } {
  if (!input.day || !isRealDay(input.day)) return { ok: false, error: 'invalid_day', message: 'day must be a YYYY-MM-DD date.' };
  const accounts = input.accounts ? [...new Set(input.accounts.split(',').map((a) => a.trim()).filter(Boolean))] : undefined;
  if (accounts && accounts.length > MAX_ACCOUNT_FILTER) return { ok: false, error: 'too_many_accounts', message: `Filter by at most ${MAX_ACCOUNT_FILTER} accounts.` };
  return { ok: true, day: input.day, accounts };
}

/**
 * Which posts moved the needle on `day` (UTC): per-post gains using the same
 * window rules as mode=gained, biggest first, plus the age-band split. Totals
 * cover every gaining post even when `posts` is capped at MAX_DAY_POSTS.
 */
export async function getSocialStatsDay(owners: string[], day: string, accountFilter?: string[]): Promise<DayResult> {
  const visible = await visibleIntegrations(owners, false);
  const wanted = accountFilter ? new Set(accountFilter) : null;
  const accounts: StatsAccount[] = visible
    .filter((row) => !wanted || wanted.has(row.id))
    .map((row) => ({ id: row.id, provider: row.provider, profile: row.profile ?? null, name: row.name ?? null, lane: laneAndPrimary(parseStoredTags(row.tags)).lane }));
  const byAge = emptyAge();
  const out: DayResult = { day, total: 0, accounts, byAge, posts: [], truncated: false };
  const ids = accounts.map((a) => a.id);
  if (!owners.length || !ids.length) return out;

  const ownerList = placeholders(2, owners.length);
  const integrationList = placeholders(2 + owners.length, ids.length);
  const [rows] = await rawBatch([
    {
      sql: `SELECT d.post_id AS post_id, d.integration_id AS integration_id, d.delta AS gained, p.content AS caption, p.published_at AS published_at,
              ${BAND_SQL} AS band
            FROM (${deltaCte(ownerList, integrationList)}) d
            JOIN social_posts p ON p.id = d.post_id
            WHERE d.day = ?1 AND d.delta > 0
            ORDER BY d.delta DESC, d.post_id`,
      params: [day, ...owners, ...ids],
    },
  ]);
  type Row = { post_id: string; integration_id: string; gained: number; caption: string | null; published_at: number | null; band: AgeBand | null };
  for (const r of (rows ?? []) as Row[]) {
    out.total += r.gained;
    byAge[r.band ?? 'unattributed'] += r.gained;
    if (out.posts.length >= MAX_DAY_POSTS) {
      out.truncated = true;
      continue;
    }
    out.posts.push({
      postId: r.post_id,
      integrationId: r.integration_id,
      caption: r.caption ? r.caption.slice(0, CAPTION_MAX) : null,
      publishedAt: r.published_at,
      gained: r.gained,
      ageBand: r.band,
    });
  }
  return out;
}

// ── daily carry-forward ─────────────────────────────────────────────────────

/**
 * Daily cron: a published post whose latest snapshot is older than yesterday
 * (UTC) — no sync landed, e.g. the platform stopped reporting — gets that
 * snapshot copied to yesterday, so its row series stays continuous (the copy
 * gains 0). Bounded per tick; the next run takes the rest.
 */
export async function carryForwardMetrics(nowMs: number = Date.now(), limit = CARRY_FORWARD_LIMIT): Promise<{ carried: number }> {
  const yesterday = msToDay(nowMs - DAY_MS);
  const [, changes] = await rawBatch([
    {
      sql: `INSERT INTO social_post_metrics_daily (post_id, day, views, likes, comments, shares, saves, reach, synced_at)
            SELECT m.post_id, ?1, m.views, m.likes, m.comments, m.shares, m.saves, m.reach, ?2
            FROM social_posts p
            JOIN social_post_metrics_daily m ON m.post_id = p.id
              AND m.day = (SELECT MAX(day) FROM social_post_metrics_daily WHERE post_id = p.id)
            WHERE p.state = 'PUBLISHED' AND m.day < ?1
            LIMIT ?3
            ON CONFLICT(post_id, day) DO NOTHING`,
      params: [yesterday, Math.floor(nowMs / 1000), limit],
    },
    { sql: 'SELECT changes() AS n', params: [] },
  ]);
  return { carried: Number((changes?.[0] as { n?: number } | undefined)?.n ?? 0) };
}
