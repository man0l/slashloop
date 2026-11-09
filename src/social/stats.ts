// Account stats chart (SLA-1439): views per account over time, from the daily
// snapshots in social_post_metrics_daily (migration 0031).
//
//   gained — per post, each day's views minus the previous snapshot's, clamped
//            at 0. A post's FIRST snapshot is a baseline (0) unless the post
//            was published that same UTC day, when it counts in full.
//   posted — views as of now, attributed to each post's publish day.
//
// Everything is UTC; the read is shared by GET /api/social/stats and the
// get_social_stats MCP tool.

import { rawBatch, type RawStatement } from '../store.js';
import { laneAndPrimary, parseStoredTags } from './rotation.js';
import { visibleIntegrations } from './posting.js';

export const STATS_BUCKETS = ['day', 'week', 'month'] as const;
export const STATS_MODES = ['gained', 'posted'] as const;
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
  buckets: Array<{ start: string; byAccount: Record<string, number> }>;
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
  if (!(STATS_MODES as readonly string[]).includes(mode)) return bad('invalid_mode', 'mode must be gained or posted.');
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

/** Window functions run over each post's whole history (the delta at the
 *  range's first day needs the snapshot before it); the range filters after. */
function gainedStatement(owners: string[], integrationIds: string[], from: string, to: string): RawStatement {
  const ownerList = placeholders(3, owners.length);
  const integrationList = placeholders(3 + owners.length, integrationIds.length);
  return {
    sql: `SELECT day, integration_id, SUM(delta) AS views FROM (
            SELECT m.day AS day, p.integration_id AS integration_id,
              CASE
                WHEN LAG(m.views) OVER w IS NULL
                  THEN CASE WHEN date(p.published_at, 'unixepoch') = m.day THEN m.views ELSE 0 END
                ELSE MAX(m.views - LAG(m.views) OVER w, 0)
              END AS delta
            FROM social_post_metrics_daily m
            JOIN social_posts p ON p.id = m.post_id
            WHERE p.owner_id IN (${ownerList}) AND p.integration_id IN (${integrationList}) AND m.views IS NOT NULL
            WINDOW w AS (PARTITION BY m.post_id ORDER BY m.day)
          ) WHERE day >= ?1 AND day <= ?2
          GROUP BY day, integration_id`,
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

  let trackingSince: string | null = null;
  if (owners.length && ids.length) {
    const statements: RawStatement[] = [
      query.mode === 'gained' ? gainedStatement(owners, ids, query.from, query.to) : postedStatement(owners, ids, query.from, query.to),
      {
        sql: `SELECT MIN(m.day) AS day FROM social_post_metrics_daily m JOIN social_posts p ON p.id = m.post_id
              WHERE p.owner_id IN (${placeholders(1, owners.length)})`,
        params: owners,
      },
    ];
    const [data, since] = await rawBatch(statements);
    for (const r of (data ?? []) as DayRow[]) {
      const slot = byStart.get(bucketStart(r.day, query.bucket));
      if (slot && r.integration_id in slot) slot[r.integration_id]! += r.views ?? 0;
    }
    trackingSince = ((since?.[0] as { day: string | null } | undefined)?.day) ?? null;
  }

  return {
    mode: query.mode,
    bucket: query.bucket,
    trackingSince,
    accounts,
    buckets: starts.map((start) => ({ start, byAccount: byStart.get(start)! })),
  };
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
