// ---------------------------------------------------------------------------
// Creator comparison — your account(s) vs everyone else you track.
//
// Every creator source in the workspace other than the isSelf ones is
// automatically in the comparison set — there is no rival flag to discover or
// set. A workspace can flag several accounts as its own (a faceless page plus
// a personal one); all of them report role 'you' and the rest are rivals.
// Medians, cadence, outlier mix; no live scrape, library data only.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { cacheKey, getOrFill } from './cache.js';
import { normalizeQuery } from './canonical-query.js';

const DAY = 24 * 60 * 60 * 1000;

export interface CreatorBenchmark {
  sourceId: string;
  handle: string;
  role: 'you' | 'creator';
  videoCount: number;
  medianViews: number;
  postsLast7d: number;
  postsLast30d: number;
  medianOutlier: number | null;
  topViews: number;
  topCaption: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function buildBenchmark(workspace: Workspace, now = new Date()) {
  // Cached 120s, keyed by UTC day — same rationale as buildWeeklyRetro.
  return getOrFill(
    cacheKey(['benchmark', workspace.id, now.toISOString().slice(0, 10)]),
    120_000,
    () => buildBenchmarkUncached(workspace, now),
  );
}

async function buildBenchmarkUncached(workspace: Workspace, now: Date) {
  const sources = await db.source.findMany({
    where: { workspaceId: workspace.id, sourceType: 'creator' },
    select: { id: true, query: true, isSelf: true },
    orderBy: { createdAt: 'asc' },
  });
  const you = sources.filter((s) => s.isSelf);
  // Every other tracked creator is the comparison set — no extra "rival" flag.
  const rivals = sources.filter((s) => !s.isSelf);

  const since7 = new Date(now.getTime() - 7 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);

  async function statsFor(source: (typeof sources)[number]): Promise<CreatorBenchmark> {
    const videos = await db.video.findMany({
      where: { sourceId: source.id, isBaselineSample: false, postedAt: { gte: since30 } },
      // Safety cap: D1 enforces a 30s per-query limit and a 1000-query scaler
      // budget per request — an unbounded per-creator pull OOMs/hangs on large
      // libraries, so bound the 30d window to the top 2000 by views.
      orderBy: { views: 'desc' },
      take: 2000,
      select: {
        views: true, postedAt: true, caption: true,
        score: { select: { outlierScore: true } },
      },
    });
    const views = videos.map((v) => v.views);
    const outliers = videos.map((v) => v.score?.outlierScore).filter((n): n is number => n != null);
    const top = videos.slice().sort((a, b) => b.views - a.views)[0];
    const role: CreatorBenchmark['role'] = source.isSelf ? 'you' : 'creator';
    return {
      sourceId: source.id,
      handle: normalizeQuery('creator', source.query),
      role,
      videoCount: videos.length,
      medianViews: median(views),
      postsLast7d: videos.filter((v) => v.postedAt >= since7).length,
      postsLast30d: videos.filter((v) => v.postedAt >= since30).length,
      medianOutlier: outliers.length ? Number((median(outliers.map((n) => Math.round(n * 10))) / 10).toFixed(1)) : null,
      topViews: top?.views ?? 0,
      topCaption: (top?.caption ?? '').slice(0, 120),
    };
  }

  // Sequential on purpose: concurrent Prisma queries hang the D1 binding.
  const youStats: CreatorBenchmark[] = [];
  for (const self of you) youStats.push(await statsFor(self));
  const rivalStats: CreatorBenchmark[] = [];
  for (const rival of rivals) rivalStats.push(await statsFor(rival));

  // Headline compares the pooled week across your accounts (a faceless page
  // and a personal page are one "you" for cadence), with the median quoted
  // from the primary — the oldest flagged — account.
  let headline = 'Track your own account, then any other creators, to compare cadence and medians.';
  if (youStats.length > 0 && rivalStats.length > 0) {
    const vs = rivalStats[0]!;
    const you = youStats[0]!;
    const yourPosts = youStats.reduce((sum, s) => sum + s.postsLast7d, 0);
    const accountNote = youStats.length > 1 ? ` across ${youStats.length} accounts` : '';
    const cadence = yourPosts === vs.postsLast7d
      ? `You and @${vs.handle} both posted ${yourPosts} time${yourPosts === 1 ? '' : 's'} this week.`
      : `You posted ${yourPosts}× this week${accountNote}; @${vs.handle} posted ${vs.postsLast7d}×.`;
    const viewsLine = vs.medianViews > 0
      ? ` Your median is ${you.medianViews.toLocaleString()} views vs @${vs.handle}'s ${vs.medianViews.toLocaleString()}.`
      : '';
    headline = cadence + viewsLine;
  } else if (youStats.length > 0) {
    const you = youStats[0]!;
    const yourPosts = youStats.reduce((sum, s) => sum + s.postsLast7d, 0);
    const accountNote = youStats.length > 1 ? ` across ${youStats.length} accounts` : '';
    headline = `Your median is ${you.medianViews.toLocaleString()} views · ${yourPosts} post${yourPosts === 1 ? '' : 's'} this week${accountNote}. Track another creator to compare.`;
  } else if (rivalStats.length > 0) {
    headline = 'Mark a tracked creator as your account on Sources to compare against the others.';
  }

  return { headline, you: youStats, creators: rivalStats };
}
