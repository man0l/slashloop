import { db } from './db.js';
import { subHours } from 'date-fns';

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

  const rows = await db.video.findMany({
    where: { creatorHandle: { in: handles }, platform: { in: platforms } },
    select: { creatorHandle: true, platform: true, views: true, postedAt: true },
  });

  const groups = new Map<string, { handle: string; platform: string; vids: { views: number; postedAt: Date }[] }>();
  for (const r of rows) {
    const key = `${r.creatorHandle}__${r.platform}`;
    if (!groups.has(key)) groups.set(key, { handle: r.creatorHandle, platform: r.platform, vids: [] });
    groups.get(key)!.vids.push({ views: r.views, postedAt: r.postedAt });
  }

  for (const [, g] of groups) {
    g.vids.sort((a, b) => +b.postedAt - +a.postedAt);
    const sample = g.vids.slice(0, 20); // last 20 by recency
    const medianViews = trimmedMedian(sample.map(v => v.views));
    result.set(`${g.handle}__${g.platform}`, { medianViews, sampleSize: sample.length });

    // Persist baseline (best-effort — scoring uses the returned median).
    try {
      await db.baseline.upsert({
        where: { creatorHandle_platform: { creatorHandle: g.handle, platform: g.platform } },
        create: { creatorHandle: g.handle, platform: g.platform, medianViews, sampleSize: sample.length },
        update: { medianViews, sampleSize: sample.length, computedAt: new Date() },
      });
    } catch {
      // best-effort
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

export function scoreVideo(
  videoId: string,
  views: number,
  baseline: number,
  scoreType: 'actual' | 'estimated',
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
    explanation = `📊 Estimated score — ${formattedViews} views vs. batch median of ~${formattedBaseline} — ${outlierScore}x (limited creator history)`;
  }

  return { videoId, outlierScore, scoreType, explanation };
}

// ---------------------------------------------------------------------------
// batchScoreVideos — score all videos for a source
// ---------------------------------------------------------------------------

export async function batchScoreVideos(sourceId: string): Promise<ScoreResult[]> {
  const videos = await db.video.findMany({
    where: { sourceId },
    orderBy: { postedAt: 'desc' },
  });

  const results: ScoreResult[] = [];
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

  // Score each video
  for (const video of videos) {
    const key = `${video.creatorHandle}__${video.platform}`;
    const baselineInfo = baselines.get(key) ?? { median: 500, sampleSize: 0 };
    const baseline = baselineInfo.median;

    if (isTooFresh(video.postedAt)) {
      const result: ScoreResult = {
        videoId: video.id,
        outlierScore: 0,
        scoreType: 'too_fresh',
        explanation: '⏳ Too fresh — posted less than 48 hours ago. Score will be calculated on next refresh.',
      };
      results.push(result);

      // Upsert score
      await db.score.upsert({
        where: { videoId: video.id },
        create: {
          videoId: video.id,
          outlierScore: 0,
          scoreType: 'too_fresh',
          explanation: result.explanation,
        },
        update: {
          outlierScore: 0,
          scoreType: 'too_fresh',
          explanation: result.explanation,
          scoredAt: new Date(),
        },
      });
      continue;
    }

    // Confidence label MUST match the baseline's scope. The baseline is built
    // from the creator's global (cross-source) history, so we decide actual vs
    // estimated from that same sampleSize. The old per-source-group check
    // mislabeled creators with strong global history as "estimated" when they
    // had <5 videos in THIS source — surfacing their viral videos as
    // high-multiple "estimated" noise instead of real, attributed outliers.
    const scoreType: 'actual' | 'estimated' = baselineInfo.sampleSize >= 5 ? 'actual' : 'estimated';

    const result = scoreVideo(video.id, video.views, baseline, scoreType);
    results.push(result);

    // Upsert score
    await db.score.upsert({
      where: { videoId: video.id },
      create: {
        videoId: video.id,
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

  return results;
}