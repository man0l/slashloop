// ---------------------------------------------------------------------------
// Refresh policy — "new outliers only" by default.
//
// A refresh is not a full re-catalogue of a creator/hashtag. History is
// already in the library (or was, until retention expired). Paying Apify for
// the same 20–50 videos again is the main cost leak: ~49% of recent pulls
// were already known (see Apify run analysis).
//
// Two modes:
//   bootstrap   — source has never produced visible videos (new track, or
//                 retention wiped the listing). Pull a modest first page of
//                 LATEST content so scoring has something to work with.
//   incremental — source already has videos. Pull a small latest page and,
//                 for creators, ask Apify for posts after our newest
//                 postedAt watermark so we mostly pay for truly new items.
//
// Explicit videoLimit on the refresh call always wins as the hard cap for
// that run (power users / deepen_baselines). Baseline-only rescrapes
// (sourceTypeOverride) are a separate path and do not use this policy.
// ---------------------------------------------------------------------------

import { subHours } from 'date-fns';
import { db } from '../db.js';

/** First fill — enough to seed scores without a $0.30 100-result scrape. */
export const REFRESH_BOOTSTRAP_CAP = 20;

/**
 * Routine re-check. clockworks returns latest-first for profiles; 5 newest
 * is enough to catch new outliers between scheduled/manual refreshes.
 */
export const REFRESH_INCREMENTAL_DEFAULT = 5;

/**
 * Even when a source's stored videoLimit is high (legacy defaults were 50),
 * incremental runs stay small unless the caller passes an explicit override.
 */
export const REFRESH_INCREMENTAL_CAP = 10;

/** Overlap so timezone/clock skew does not skip a video at the watermark edge. */
const WATERMARK_OVERLAP_HOURS = 12;

/**
 * How many consecutive runs must come back with nothing new before a source
 * is treated as dry.
 *
 * Measured over 110 policy-era refreshes: 894 results pulled, 433 new — 51.6%
 * of what we paid for was already in the library or older than the recency
 * cutoff. Capping the page at 5 made each run cheap without making it
 * efficient; cost per NEW video only fell from 1.07c to 0.85c. The waste is
 * concentrated in sources that keep returning the same latest page (hashtags
 * get no date filter, so nothing stops them), so the lever is to stop buying
 * a full page from a source that has not produced a new video in a while.
 */
export const REFRESH_DRY_RUN_LOOKBACK = 3;

/** Page size for a source that has gone dry. Still enough to notice a revival. */
export const REFRESH_DRY_LIMIT = 2;

export type RefreshMode = 'bootstrap' | 'incremental';

export interface RefreshPlan {
  mode: RefreshMode;
  /**
   * True when the last REFRESH_DRY_RUN_LOOKBACK runs all produced zero new
   * videos and the page was narrowed as a result. Surfaced so the saving is
   * auditable rather than an invisible behaviour change.
   */
  dry?: boolean;
  /** resultsPerPage / credit pre-auth size for this run. */
  limit: number;
  /**
   * Creator scrapes only: ask Apify for videos posted on/after this instant
   * (maps to oldestPostDateUnified — $0.001 date-filter add-on).
   * Hashtag/keyword scrapes leave this undefined (actor date filter is
   * profile-scoped); they rely on the small latest page instead.
   */
  postedAfter?: Date;
  /** Why this plan was chosen — surfaces in RefreshRun.errorsJson for support. */
  reason: string;
}

export interface SourceRefreshInput {
  id: string;
  sourceType: string;
  videoLimit: number;
  lastRefreshedAt: Date | null;
}

/**
 * Decide how large a scrape this refresh needs and whether to date-filter.
 *
 * @param limitOverride explicit cap from the user/API for THIS run only.
 *   When set, it is the limit (still subject to a floor of 1). Mode and
 *   watermark still follow library state so a large override on an
 *   established source remains "new-ish" rather than a full history dump.
 */
export async function resolveRefreshPlan(
  source: SourceRefreshInput,
  limitOverride?: number,
): Promise<RefreshPlan> {
  // Count all rows for this source. Baseline-only samples (when the column
  // exists in prod) are rare and still mean "we have library state" — better
  // to run incremental than to re-bootstrap a full page.
  const videoCount = await db.video.count({
    where: { sourceId: source.id },
  });

  const isBootstrap = videoCount === 0;
  const mode: RefreshMode = isBootstrap ? 'bootstrap' : 'incremental';

  let limit: number;
  let reason: string;
  let dry = false;

  // Has this source produced anything on its recent runs? A source that keeps
  // handing back the same page it already handed back is the remaining cost
  // leak once the page itself is small (see REFRESH_DRY_RUN_LOOKBACK).
  if (!isBootstrap) {
    const recent = await db.refreshRun.findMany({
      where: { sourceId: source.id },
      orderBy: { ranAt: 'desc' },
      take: REFRESH_DRY_RUN_LOOKBACK,
      select: { newVideos: true, itemsPulled: true },
    });
    dry =
      recent.length >= REFRESH_DRY_RUN_LOOKBACK
      // Only counts if those runs actually saw results. Three runs that
      // returned nothing at all are a broken source or a failing actor, not
      // a quiet creator, and narrowing the page would not help either way.
      && recent.every(r => r.newVideos === 0 && r.itemsPulled > 0);
  }

  if (limitOverride != null && Number.isFinite(limitOverride) && limitOverride >= 1) {
    limit = Math.floor(limitOverride);
    reason = isBootstrap
      ? `bootstrap with explicit limitOverride=${limit}`
      : `incremental with explicit limitOverride=${limit}`;
    // A caller-supplied limit is a ceiling, not a demand: an explicit 5 on a
    // source that has been dry for three runs still only needs a couple of
    // results to notice it woke up. Callers that pass the policy's own limit
    // back in (the queue does exactly this, to freeze the pre-auth size)
    // would otherwise defeat the backoff entirely.
    if (dry && limit > REFRESH_DRY_LIMIT) {
      limit = REFRESH_DRY_LIMIT;
      reason += `; dry source (last ${REFRESH_DRY_RUN_LOOKBACK} runs found nothing new) → narrowed to ${limit}`;
    }
  } else if (isBootstrap) {
    limit = Math.min(Math.max(1, source.videoLimit), REFRESH_BOOTSTRAP_CAP);
    reason = `bootstrap: no videos yet; limit=min(videoLimit=${source.videoLimit}, cap=${REFRESH_BOOTSTRAP_CAP})→${limit}`;
  } else {
    limit = Math.min(
      Math.max(1, source.videoLimit),
      REFRESH_INCREMENTAL_DEFAULT,
      REFRESH_INCREMENTAL_CAP,
    );
    reason = `incremental: ${videoCount} videos held; limit=${limit} (new outliers only)`;
    if (dry) {
      limit = Math.min(limit, REFRESH_DRY_LIMIT);
      reason += `; dry source (last ${REFRESH_DRY_RUN_LOOKBACK} runs found nothing new) → narrowed to ${limit}`;
    }
  }

  let postedAfter: Date | undefined;
  if (mode === 'incremental' && source.sourceType === 'creator') {
    const newest = await db.video.findFirst({
      where: { sourceId: source.id },
      orderBy: { postedAt: 'desc' },
      select: { postedAt: true },
    });
    if (newest) {
      postedAfter = subHours(newest.postedAt, WATERMARK_OVERLAP_HOURS);
      reason += `; creator watermark postedAfter=${postedAfter.toISOString()} (newest−${WATERMARK_OVERLAP_HOURS}h)`;
    }
  }

  return { mode, limit, postedAfter, reason, dry };
}
