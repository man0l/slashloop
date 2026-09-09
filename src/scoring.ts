import { db } from './db.js';
import { D1_PARAM_CHUNK, chunked, dbDialect, rawBatch, type RawStatement } from './store.js';
import { subHours } from 'date-fns';
import { enqueueRefreshJob, outstandingJobForSource } from './lib/jobs.js';
import { CREDIT_COSTS, creditBalance } from './lib/credits.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreResult {
  videoId: string;
  outlierScore: number;
  scoreType: 'actual' | 'estimated' | 'too_fresh';
  explanation: string;
}

export interface BaselineResult {
  creatorHandle: string;
  platform: string;
  medianViews: number;
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString();
}

export function isTooFresh(postedAt: Date): boolean {
  const cutoff = subHours(new Date(), 48);
  return new Date(postedAt) > cutoff;
}

function trimmedMedian(values: number[]): number {
  if (values.length === 0) return 500; // floor
  if (values.length <= 2) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.max(500, avg);
  }

  // Drop top and bottom 10%
  const dropCount = Math.max(1, Math.floor(values.length * 0.1));
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(dropCount, sorted.length - dropCount);

  if (trimmed.length === 0) return Math.max(500, sorted[Math.floor(sorted.length / 2)]);

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 !== 0
    ? trimmed[mid]
    : (trimmed[mid - 1] + trimmed[mid]) / 2;

  return Math.max(500, median); // floor of 500
}

// ---------------------------------------------------------------------------
// D1 bulk upserts — one INSERT..ON CONFLICT..DO UPDATE per chunk instead of
// one Prisma upsert per row (rawBatch throws on Postgres; every call site is
// dialect-branched, exactly like src/lib/credits.ts).
//
// D1 caps bound parameters per query at ~100 (store.ts D1_PARAM_CHUNK), so a
// chunk is D1_PARAM_CHUNK / params-per-row — NOT D1_PARAM_CHUNK rows — and
// each chunk goes out as its own rawBatch statement.
// ---------------------------------------------------------------------------

/** Score upsert binds videoId, outlierScore, scoreType, explanation, scoredAt. */
const SCORE_ROWS_PER_STATEMENT = Math.floor(D1_PARAM_CHUNK / 5); // 18 rows × 5 params = 90
/** Baseline upsert binds creatorHandle, platform, medianViews, sampleSize, computedAt. */
const BASELINE_ROWS_PER_STATEMENT = Math.floor(D1_PARAM_CHUNK / 5); // 18 rows × 5 params = 90

async function upsertScoresSqlite(results: ScoreResult[]): Promise<void> {
  const scoredAt = new Date();
  for (let i = 0; i < results.length; i += SCORE_ROWS_PER_STATEMENT) {
    const chunk = results.slice(i, i + SCORE_ROWS_PER_STATEMENT);
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (const r of chunk) {
      placeholders.push('(?, ?, ?, ?, ?)');
      params.push(r.videoId, r.outlierScore, r.scoreType, r.explanation, scoredAt);
    }
    const stmt: RawStatement = {
      sql: `INSERT INTO "Score" ("videoId", "outlierScore", "scoreType", "explanation", "scoredAt")
            VALUES ${placeholders.join(', ')}
            ON CONFLICT ("videoId") DO UPDATE SET
              "outlierScore" = excluded."outlierScore",
              "scoreType" = excluded."scoreType",
              "explanation" = excluded."explanation",
              "scoredAt" = excluded."scoredAt"`,
      params,
    };
    await rawBatch([stmt]);
  }
}

async function upsertBaselinesSqlite(
  entries: Array<{ creatorHandle: string; platform: string; medianViews: number; sampleSize: number }>,
): Promise<void> {
  const computedAt = new Date();
  for (let i = 0; i < entries.length; i += BASELINE_ROWS_PER_STATEMENT) {
    const chunk = entries.slice(i, i + BASELINE_ROWS_PER_STATEMENT);
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (const e of chunk) {
      placeholders.push('(?, ?, ?, ?, ?)');
      params.push(e.creatorHandle, e.platform, e.medianViews, e.sampleSize, computedAt);
    }
    const stmt: RawStatement = {
      sql: `INSERT INTO "Baseline" ("creatorHandle", "platform", "medianViews", "sampleSize", "computedAt")
            VALUES ${placeholders.join(', ')}
            ON CONFLICT ("creatorHandle", "platform") DO UPDATE SET
              "medianViews" = excluded."medianViews",
              "sampleSize" = excluded."sampleSize",
              "computedAt" = excluded."computedAt"`,
      params,
    };
    await rawBatch([stmt]);
  }
}

// ---------------------------------------------------------------------------
// computeCreatorBaseline
// ---------------------------------------------------------------------------

export async function computeCreatorBaseline(
  creatorHandle: string,
  platform: string,
  candidateVideoId?: string,
  candidatePostedAt?: Date,
): Promise<BaselineResult> {
  // Fetch videos for this creator on this platform, ordered by postedAt desc
  const where: any = {
    creatorHandle,
    platform,
  };

  const videos = await db.video.findMany({
    where,
    orderBy: { postedAt: 'desc' },
    select: { id: true, postedAt: true, views: true },
    take: 30, // fetch more than 20 to have room after filtering
  });

  // Exclude the candidate video itself
  let candidateVideos = videos;
  if (candidateVideoId && candidatePostedAt) {
    candidateVideos = videos.filter(v => {
      if (v.id === candidateVideoId) return false;
      // Only use videos posted before the candidate
      return new Date(v.postedAt) < new Date(candidatePostedAt);
    });
  }

  // Take last 20 (most recent before candidate)
  const sample = candidateVideos.slice(0, 20);
  const viewCounts = sample.map(v => v.views);

  const medianViews = trimmedMedian(viewCounts);

  // Upsert baseline
  await db.baseline.upsert({
    where: {
      creatorHandle_platform: { creatorHandle, platform },
    },
    create: {
      creatorHandle,
      platform,
      medianViews,
      sampleSize: viewCounts.length,
    },
    update: {
      medianViews,
      sampleSize: viewCounts.length,
      computedAt: new Date(),
    },
  });

  return {
    creatorHandle,
    platform,
    medianViews,
    sampleSize: viewCounts.length,
  };
}

// ---------------------------------------------------------------------------
// computeSearchBatchBaseline
// ---------------------------------------------------------------------------

export function computeSearchBatchBaseline(views: number[]): number {
  if (views.length === 0) return 500;
  const sorted = [...views].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(500, median);
}

// ---------------------------------------------------------------------------
// computeCreatorBaselinesBatch — one query for many creators
// ---------------------------------------------------------------------------

// Fetches cross-source history for a set of (handle, platform) pairs in a
// SINGLE query and computes each creator's trimmed median in memory. Replaces
// the old per-creator computeCreatorBaseline loop, which fired 2 DB round-trips
// per creator (~80 sequential queries for a 40-creator hashtag source) — slow
// and pooler-hostile (the Supabase pooler resets idle connections mid-batch).
export async function computeCreatorBaselinesBatch(
  creators: { handle: string; platform: string }[],
): Promise<Map<string, { medianViews: number; sampleSize: number }>> {
  const result = new Map<string, { medianViews: number; sampleSize: number }>();
  if (creators.length === 0) return result;

  const handles = [...new Set(creators.map(c => c.handle))];
  const platforms = [...new Set(creators.map(c => c.platform))];

  // Chunked: D1 caps bound parameters at ~100 and a big refresh can hold
  // up to videoLimit (200) distinct creators.
  const rows: Array<{ creatorHandle: string; platform: string; views: number; postedAt: Date }> = [];
  await chunked(handles, async (chunk) => {
    const part = await db.video.findMany({
      where: { creatorHandle: { in: chunk }, platform: { in: platforms } },
      select: { creatorHandle: true, platform: true, views: true, postedAt: true },
    });
    rows.push(...part);
  });

  const groups = new Map<string, { handle: string; platform: string; vids: { views: number; postedAt: Date }[] }>();
  for (const r of rows) {
    const key = `${r.creatorHandle}__${r.platform}`;
    if (!groups.has(key)) groups.set(key, { handle: r.creatorHandle, platform: r.platform, vids: [] });
    groups.get(key)!.vids.push({ views: r.views, postedAt: r.postedAt });
  }

  const persisted: Array<{ creatorHandle: string; platform: string; medianViews: number; sampleSize: number }> = [];
  for (const [, g] of groups) {
    g.vids.sort((a, b) => +b.postedAt - +a.postedAt);
    const sample = g.vids.slice(0, 20); // last 20 by recency
    const medianViews = trimmedMedian(sample.map(v => v.views));
    result.set(`${g.handle}__${g.platform}`, { medianViews, sampleSize: sample.length });
    persisted.push({ creatorHandle: g.handle, platform: g.platform, medianViews, sampleSize: sample.length });
  }

  // Persist baselines (best-effort — scoring uses the returned median). The
  // upsert is free on failures here on purpose: a baseline write must never
  // fail a rescore that already has the median in memory.
  if (persisted.length > 0) {
    if (dbDialect() === 'sqlite') {
      // D1 bulk upsert: ~N/18 chunky INSERT..ON CONFLICT statements instead of
      // one baseline.upsert per creator group (a 200-creator hashtag scrape
      // fired 200 sequential upserts against the single D1 writer).
      try {
        await upsertBaselinesSqlite(persisted);
      } catch {
        // best-effort
      }
    } else {
      for (const e of persisted) {
        try {
          await db.baseline.upsert({
            where: { creatorHandle_platform: { creatorHandle: e.creatorHandle, platform: e.platform } },
            create: { creatorHandle: e.creatorHandle, platform: e.platform, medianViews: e.medianViews, sampleSize: e.sampleSize },
            update: { medianViews: e.medianViews, sampleSize: e.sampleSize, computedAt: new Date() },
          });
        } catch {
          // best-effort
        }
      }
    }
  }

  // Ensure every requested creator has an entry (floor 500, sampleSize 0).
  for (const c of creators) {
    const key = `${c.handle}__${c.platform}`;
    if (!result.has(key)) result.set(key, { medianViews: 500, sampleSize: 0 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// scoreVideo
// ---------------------------------------------------------------------------

/**
 * Reach relative to the creator's own audience, below which an `estimated`
 * score should not be presented as a breakout.
 *
 * A video that reaches fewer people than the creator has followers has, by
 * definition, under-performed for that creator — whatever it looks like against
 * a hashtag median. Measured against four paid verifications: the three
 * creators above this line all held up when re-scored against their own median
 * (510→563x, 273→295x, 169→167x); the one below it collapsed from 438x to 1.3x.
 * @mikaylanogueira has 17.4M followers and that video reached 5.7M — utterly
 * normal for her, and the product was calling it a 438x OUTLIER.
 */
const UNDER_REACH_RATIO = 1;

export function scoreVideo(
  videoId: string,
  views: number,
  baseline: number,
  scoreType: 'actual' | 'estimated',
  /**
   * Creator follower count, when known. Already on every Video row, so this
   * confidence check costs nothing — no extra query, no scrape, no credits.
   */
  creatorFollowers?: number | null,
): ScoreResult {
  const outlierScore = Math.round((views / baseline) * 10) / 10;
  const formattedViews = formatNumber(views);
  const formattedBaseline = formatNumber(baseline);

  let explanation: string;
  if (scoreType === 'actual') {
    if (outlierScore >= 5) {
      explanation = `🚀 OUTLIER — ${formattedViews} views vs. this creator's typical ~${formattedBaseline} — ${outlierScore}x their normal performance`;
    } else if (outlierScore >= 2) {
      explanation = `📈 Above average — ${formattedViews} views vs. this creator's typical ~${formattedBaseline} — ${outlierScore}x their normal performance`;
    } else if (outlierScore >= 1) {
      explanation = `📊 Normal range — ${formattedViews} views vs. this creator's typical ~${formattedBaseline} — ${outlierScore}x their normal performance`;
    } else {
      explanation = `📉 Below average — ${formattedViews} views vs. this creator's typical ~${formattedBaseline} — ${outlierScore}x their normal performance`;
    }
  } else {
    // baseline here is the source/batch median (see batchScoreVideos), not the
    // creator's own single video — otherwise every one-off scrape scores ~1.0x.
    //
    // The confidence check below is the difference between a useful number and
    // a misleading one. An estimated score compares a video to its SOURCE, so a
    // large account posting normally into a niche hashtag scores in the
    // hundreds. Presenting that with the same 🚀 language as a real breakout is
    // how the product ended up ranking a 1.3x video second overall.
    const ratio = creatorFollowers && creatorFollowers > 0 ? views / creatorFollowers : null;

    if (ratio !== null && ratio < UNDER_REACH_RATIO) {
      explanation =
        `⚠️ Unverified — ${formattedViews} views is ${outlierScore}x this source's median of `
        + `~${formattedBaseline}, but this creator has ${formatNumber(creatorFollowers!)} followers, so the `
        + `video reached FEWER people than follow them. That is normal performance for an account this size, `
        + `not a breakout — the high multiple reflects the hashtag being small. `
        + `Treat with suspicion; deepen_baselines can confirm against their own median.`;
    } else {
      const reach = ratio !== null ? ` (reached ${Math.round(ratio * 10) / 10}x their follower count)` : '';
      explanation =
        `📊 Estimated score — ${formattedViews} views vs. this source's median of ~${formattedBaseline} — `
        + `${outlierScore}x (limited creator history)${reach}`;
    }
  }

  return { videoId, outlierScore, scoreType, explanation };
}

// ---------------------------------------------------------------------------
// batchScoreVideos — score all videos for a source
// ---------------------------------------------------------------------------

/**
 * Minimum creator-history sample size before we trust a per-creator baseline.
 * Below this, views/creatorMedian collapses to ~1.0x for one-off hashtag hits
 * (baseline ≈ the video itself). We fall back to the source batch median so
 * discovery scrapes still surface true niche outliers.
 */
export const CREATOR_BASELINE_MIN_SAMPLE = 5;

/**
 * Cap on distinct (creator, platform, workspace) groups considered per call,
 * and how long this pass may run before ceding the rest of the worker's time
 * budget to the primary fetch/analyze/rescore/refresh queues that run after
 * it (see api/jobs/analyze.ts) — a real scrape can take 10-30s, so both stay
 * small. Any groups left over are picked up on the next minute's drain; a
 * video only ever needs this once (its scoreType leaves 'too_fresh' for good
 * the moment it's rescored), so a shallow per-minute pass still clears a
 * backlog quickly without risking the invocation.
 */
const RESCORE_STALE_GROUP_CAP = 20;
const RESCRAPE_STALE_MAX_DURATION_MS = 15_000;

/** Small, bounded top-up scrape per stale creator — enough to pick up their
 *  latest stats without pulling a whole source's full (possibly much
 *  larger) videoLimit. */
const STALE_RESCRAPE_LIMIT = 5;

/**
 * Skip paying for another rescrape if this creator's baseline was already
 * refreshed within this window — most often because an earlier stale video
 * of theirs (this pass or an adjacent minute's) already paid for one. Keeps
 * "don't scrape the same creator's 5 videos over and over" true even under a
 * burst of several videos from the same creator going stale close together.
 */
export const BASELINE_RESCRAPE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Videos posted under 48h ago are scored 'too_fresh' with outlierScore 0.
 * Once 48h passes they're eligible for a real score, but a video's own
 * `views` column is frozen at whatever it was when first scraped — almost
 * certainly still tiny, since it was captured while under 48h old. Recomputing
 * from that stale number alone (an earlier version of this function) cleared
 * the 0x placeholder but didn't reflect the video's actual current
 * performance.
 *
 * So this spends real scrape credits to re-fetch current stats before
 * rescoring — but scoped to the video's CREATOR, not the source that
 * originally discovered it. Outlier scoring compares a video to its
 * creator's own baseline (computeCreatorBaseline), built from that
 * creator's videos across every source that has ever found them. Re-running
 * a hashtag/keyword source's own query again mostly surfaces a different
 * set of creators each time and rarely re-includes the specific stale
 * video at all — a creator-scoped scrape (refresh job payload
 * sourceTypeOverride/queryOverride) targets the actual person the score is
 * measured against, regardless of which source's bookkeeping the resulting
 * rows are attributed to.
 *
 * The scrape itself is a `refresh` job so the dedicated scraper worker
 * (SCRAPER_PROVIDER=proxy) owns it. This function only decides WHO to
 * queue. Running runRefresh inline here used to scrape from whichever
 * process called it (the rescore/maintenance worker), which did not have
 * the proxy provider set and fell through to Apify.
 *
 * Grouped by (creatorHandle, platform, workspaceId) — the same creator can
 * be stale in more than one source within a workspace (dedupe to one scrape
 * covering all of them), and billing must still land on each source's own
 * workspace, so a creator stale in two different workspaces is two separate
 * groups. Runs unattended, across every workspace, on the existing
 * per-minute worker drain — no user action required and no confirmation
 * prompt, since it is inherently self-limiting (each video only ever needs
 * this once). Each workspace's own credit balance and the platform-wide
 * Apify spend cap are still enforced exactly as any other refresh would be,
 * so a workspace that's out of credits is skipped rather than blocked or
 * billed regardless — see runRefresh's InsufficientCreditsError /
 * cap_breached refusal paths.
 *
 * Falls back to the old free recompute-from-stored-views behaviour whenever
 * the rescrape itself is refused or fails, so a video still isn't stuck
 * showing the placeholder even when it can't be paid for right now.
 */
export async function rescoreStaleTooFresh(): Promise<{ creatorsRescraped: number; sourcesRescoredOnly: number }> {
  const startedAt = Date.now();
  const cutoff = subHours(new Date(), 48);
  const stale = await db.video.findMany({
    where: { postedAt: { lte: cutoff }, score: { is: { scoreType: 'too_fresh' } } },
    select: { creatorHandle: true, platform: true, sourceId: true, postedAt: true, source: { select: { workspaceId: true } } },
    // Cast a wider net than the group cap below — many stale videos collapse
    // into few distinct creators, so scanning more rows costs nothing extra
    // (one indexed query) but yields a fuller, more useful set of groups.
    take: RESCORE_STALE_GROUP_CAP * 5,
  });

  const groups = new Map<string, { creatorHandle: string; platform: string; workspaceId: string; sourceId: string; latestStalePostedAt: Date }>();
  for (const v of stale) {
    if (!v.source) continue;
    const key = `${v.creatorHandle}__${v.platform}__${v.source.workspaceId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        creatorHandle: v.creatorHandle,
        platform: v.platform,
        workspaceId: v.source.workspaceId,
        // Any one of the creator's stale videos' sources works as the
        // record-keeping home for whatever this scrape finds/updates.
        sourceId: v.sourceId,
        latestStalePostedAt: v.postedAt,
      });
    } else if (v.postedAt > existing.latestStalePostedAt) {
      existing.latestStalePostedAt = v.postedAt;
    }
  }

  let creatorsRescraped = 0;
  let sourcesRescoredOnly = 0;

  // A workspace that cannot cover the pre-auth must not have refresh jobs
  // enqueued for it. Every such job is claimed, refused by debitCredits, and
  // failed within seconds — and this sweep reruns every few minutes from two
  // workers, so one out-of-credit workspace with stale videos minted that
  // claim/refuse/fail churn forever (the videos stay too_fresh, since only a
  // landed rescrape re-scores them). Degrade to the free recompute instead; a
  // top-up or plan reset re-arms the rescrape on a later sweep.
  const staleRescrapeCost = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * STALE_RESCRAPE_LIMIT);
  // One balance read per workspace per sweep — a burst of stale videos from
  // one workspace collapses into many groups that all share its balance.
  const balanceByWorkspace = new Map<string, number>();
  const workspaceCanAfford = async (workspaceId: string): Promise<boolean> => {
    const cached = balanceByWorkspace.get(workspaceId);
    if (cached !== undefined) return cached >= staleRescrapeCost;
    // A failed balance read counts as cannot-pay: enqueueing blind is the
    // churn this gate exists to stop, and the next sweep retries the read.
    const total = await creditBalance(workspaceId).then((b) => b.total).catch(() => -1);
    balanceByWorkspace.set(workspaceId, total);
    return total >= staleRescrapeCost;
  };

  for (const { creatorHandle, platform, workspaceId, sourceId, latestStalePostedAt } of [...groups.values()].slice(0, RESCORE_STALE_GROUP_CAP)) {
    // Leave whatever's left for the next minute's drain rather than risking
    // this invocation's budget — the primary job queues still run after this.
    if (Date.now() - startedAt > RESCRAPE_STALE_MAX_DURATION_MS) break;

    if (!(await workspaceCanAfford(workspaceId))) {
      await batchScoreVideos(sourceId).catch((err) => {
        console.warn(`[scoring] fallback rescore failed for source ${sourceId}: ${(err as Error).message}`);
      });
      sourcesRescoredOnly++;
      continue;
    }

    // Don't pay to re-scrape a creator whose baseline was refreshed recently
    // — likely by this same pass, for a different stale video of theirs.
    // Baseline.computedAt already exists and is touched by every scoring
    // pass (computeCreatorBaselinesBatch), so it doubles as "how fresh is
    // what we already have" with no new table needed.
    //
    // Time alone isn't enough, though: a creator who posts frequently can
    // have a brand new video the last rescrape never saw, even minutes
    // later — "posted after our last real check" always overrides the
    // cooldown, because the point of rescraping is specifically to pick up
    // content we don't have yet, and computedAt only proves we checked
    // BEFORE that video existed, not that we've seen it.
    const baseline = await db.baseline.findUnique({
      where: { creatorHandle_platform: { creatorHandle, platform } },
    });
    const alreadyCoveredByLastCheck = baseline && baseline.computedAt > latestStalePostedAt;
    const withinCooldown = baseline && Date.now() - baseline.computedAt.getTime() < BASELINE_RESCRAPE_COOLDOWN_MS;
    if (alreadyCoveredByLastCheck && withinCooldown) {
      await batchScoreVideos(sourceId).catch((err) => {
        console.warn(`[scoring] fallback rescore failed for source ${sourceId}: ${(err as Error).message}`);
      });
      sourcesRescoredOnly++;
      continue;
    }

    let queued = false;
    try {
      const outstanding = await outstandingJobForSource(sourceId, 'refresh');
      if (outstanding) {
        console.log(
          `[scoring] stale too_fresh: ${creatorHandle} skipped — refresh already ${outstanding.status} on ${sourceId.slice(0, 8)}`,
        );
      } else {
        await enqueueRefreshJob({
          workspaceId,
          sourceId,
          videoLimit: STALE_RESCRAPE_LIMIT,
          deadlineAt: new Date(Date.now() + 30 * 60 * 1000),
          payload: {
            limitOverride: STALE_RESCRAPE_LIMIT,
            sourceTypeOverride: 'creator',
            queryOverride: creatorHandle,
          },
        });
        queued = true;
        creatorsRescraped++;
        console.log(
          `[scoring] stale too_fresh: queued creator scrape @${creatorHandle} via refresh worker (limit=${STALE_RESCRAPE_LIMIT})`,
        );
      }
    } catch (err) {
      console.warn(`[scoring] stale too_fresh enqueue failed for creator ${creatorHandle}: ${(err as Error).message}`);
    }

    // The refresh worker will persist + score. Only fall back to the free,
    // stale-data recompute when we could not even queue the scrape.
    if (!queued) {
      await batchScoreVideos(sourceId).catch((err) => {
        console.warn(`[scoring] fallback rescore failed for source ${sourceId}: ${(err as Error).message}`);
      });
      sourcesRescoredOnly++;
    }
  }

  return { creatorsRescraped, sourcesRescoredOnly };
}

export async function batchScoreVideos(sourceId: string): Promise<ScoreResult[]> {
  const videos = await db.video.findMany({
    where: { sourceId },
    orderBy: { postedAt: 'desc' },
  });

  const source = await db.source.findUnique({ where: { id: sourceId } });
  const workspaceId = source?.workspaceId;

  // Group by creator (handle+platform carried on the group — TikTok handles
  // commonly contain underscores, so we never re-parse the key back out).
  const creatorGroups = new Map<string, { handle: string; platform: string; videos: typeof videos }>();
  for (const v of videos) {
    const key = `${v.creatorHandle}__${v.platform}`;
    if (!creatorGroups.has(key)) creatorGroups.set(key, { handle: v.creatorHandle, platform: v.platform, videos: [] });
    creatorGroups.get(key)!.videos.push(v);
  }

  // Compute baselines in ONE cross-source query (was: a per-creator loop that
  // fired ~2 DB round-trips per creator — slow and pooler-hostile, the Supabase
  // pooler reset idle connections mid-batch). sampleSize reflects global
  // creator history and drives the actual/estimated confidence label below.
  const batch = await computeCreatorBaselinesBatch(
    [...creatorGroups.values()].map(g => ({ handle: g.handle, platform: g.platform })),
  );
  const baselines = new Map<string, { median: number; sampleSize: number }>();
  for (const [key] of creatorGroups) {
    const info = batch.get(key) ?? { medianViews: 500, sampleSize: 0 };
    baselines.set(key, { median: info.medianViews, sampleSize: info.sampleSize });
  }

  // Source-level median: what "normal" looks like in this scrape/source.
  // Used when a creator has too little history for a meaningful personal baseline.
  const sourceBatchBaseline = computeSearchBatchBaseline(videos.map(v => v.views));

  // Score each video — compute ALL results first, then persist in one shot.
  // SQLite (D1): the whole page goes out as ~N/18 chunky INSERT..ON CONFLICT
  // statements instead of N sequential score.upserts against the single D1
  // writer (a 200-video refresh was 200 round-trips; now ≤12).
  const results: ScoreResult[] = [];
  for (const video of videos) {
    const key = `${video.creatorHandle}__${video.platform}`;
    const baselineInfo = baselines.get(key) ?? { median: 500, sampleSize: 0 };

    if (isTooFresh(video.postedAt)) {
      results.push({
        videoId: video.id,
        outlierScore: 0,
        scoreType: 'too_fresh',
        explanation: '⏳ Too fresh — posted less than 48 hours ago. Score will be calculated on next refresh.',
      });
      continue;
    }

    // actual  = enough creator history → score vs that creator's trimmed median
    // estimated = thin history → score vs THIS SOURCE's view median so hashtag/
    // keyword discovery still ranks true niche outliers (not a wall of 1.0x).
    const scoreType: 'actual' | 'estimated' =
      baselineInfo.sampleSize >= CREATOR_BASELINE_MIN_SAMPLE ? 'actual' : 'estimated';
    const baseline =
      scoreType === 'actual' ? baselineInfo.median : sourceBatchBaseline;

    results.push(scoreVideo(video.id, video.views, baseline, scoreType, video.creatorFollowers));
  }

  if (dbDialect() === 'sqlite') {
    // D1 bulk upsert (rawBatch throws on Postgres — the branch above is the
    // line in the sand). Same upsert semantics as the Prisma per-row call:
    // create when the Score row is missing, overwrite + stamp scoredAt when it
    // exists, identical columns in both branches.
    await upsertScoresSqlite(results);
  } else {
    for (const result of results) {
      await db.score.upsert({
        where: { videoId: result.videoId },
        create: {
          videoId: result.videoId,
          outlierScore: result.outlierScore,
          scoreType: result.scoreType,
          explanation: result.explanation,
        },
        update: {
          outlierScore: result.outlierScore,
          scoreType: result.scoreType,
          explanation: result.explanation,
          scoredAt: new Date(),
        },
      });
    }
  }

  return results;
}
