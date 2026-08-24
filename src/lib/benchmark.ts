// ---------------------------------------------------------------------------
// Creator comparison — your account vs everyone else you track.
//
// Every creator source in the workspace other than isSelf is automatically
// in the comparison set — there is no rival flag to discover or set. Medians,
// cadence, outlier mix; no live scrape, library data only.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
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
  const sources = await db.source.findMany({
    where: { workspaceId: workspace.id, sourceType: 'creator' },
    select: { id: true, query: true, isSelf: true },
    orderBy: { createdAt: 'asc' },
  });
  const you = sources.find((s) => s.isSelf) ?? null;
  // Every other tracked creator is the comparison set — no extra "rival" flag.
  const rivals = sources.filter((s) => !s.isSelf);

  const since7 = new Date(now.getTime() - 7 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);

  async function statsFor(source: (typeof sources)[number]): Promise<CreatorBenchmark> {
    const videos = await db.video.findMany({
      where: { sourceId: source.id, isBaselineSample: false },
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

  const youStats = you ? await statsFor(you) : null;
  const rivalStats = await Promise.all(rivals.map(statsFor));

  let headline = 'Track your own account, then any other creators, to compare cadence and medians.';
  if (youStats && rivalStats.length > 0) {
    const vs = rivalStats[0]!;
    const cadence = youStats.postsLast7d === vs.postsLast7d
      ? `You and @${vs.handle} both posted ${youStats.postsLast7d} time${youStats.postsLast7d === 1 ? '' : 's'} this week.`
      : `You posted ${youStats.postsLast7d}× this week; @${vs.handle} posted ${vs.postsLast7d}×.`;
    const viewsLine = vs.medianViews > 0
      ? ` Your median is ${youStats.medianViews.toLocaleString()} views vs @${vs.handle}'s ${vs.medianViews.toLocaleString()}.`
      : '';
    headline = cadence + viewsLine;
  } else if (youStats) {
    headline = `Your median is ${youStats.medianViews.toLocaleString()} views · ${youStats.postsLast7d} post${youStats.postsLast7d === 1 ? '' : 's'} this week. Track another creator to compare.`;
  } else if (rivalStats.length > 0) {
    headline = 'Mark a tracked creator as your account on Sources to compare against the others.';
  }

  return { headline, you: youStats, creators: rivalStats };
}
