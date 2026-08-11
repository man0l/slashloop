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

export type RefreshMode = 'bootstrap' | 'incremental';

export interface RefreshPlan {
  mode: RefreshMode;
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

  if (limitOverride != null && Number.isFinite(limitOverride) && limitOverride >= 1) {
    limit = Math.floor(limitOverride);
    reason = isBootstrap
      ? `bootstrap with explicit limitOverride=${limit}`
      : `incremental with explicit limitOverride=${limit}`;
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

  return { mode, limit, postedAfter, reason };
}
