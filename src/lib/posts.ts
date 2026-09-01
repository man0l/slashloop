// ---------------------------------------------------------------------------
// Weekly retro — Studio, read-only over the owner's own feed.
//
// There is no post log. The workspace's isSelf creator source IS the record
// of what the owner published: refresh_source pulls their TikTok feed like
// any other creator's, and this file scores those videos against that same
// creator's baseline median. The empty state is a resync, never data entry.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { normalizeQuery } from './canonical-query.js';

const RETRO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetroRow {
  id: string;
  url: string;
  postedAt: string;
  caption: string;
  views: number;
  outlierScore: number | null;
  vsMedian: number | null;
}

export async function buildWeeklyRetro(workspace: Workspace, now = new Date()) {
  const since = new Date(now.getTime() - RETRO_WINDOW_MS);
  const self = await db.source.findFirst({
    where: { workspaceId: workspace.id, isSelf: true, sourceType: 'creator' },
    select: { id: true, query: true, lastRefreshedAt: true },
  });
  const handle = self ? normalizeQuery('creator', self.query) : null;

  if (!self) {
    return {
      since: since.toISOString(),
      until: now.toISOString(),
      needsAccount: true,
      needsResync: false,
      selfSourceId: null,
      selfHandle: null,
      videoCount: 0,
      medianViews: null,
      lastPostedAt: null,
      selfLastRefreshedAt: null,
      headline: 'Mark a tracked creator as your account on Sources — Studio reads that feed. Nothing to log by hand.',
      rows: [] as RetroRow[],
    };
  }

  // Sequential on purpose: concurrent Prisma queries hang the D1 binding.
  const baseline = await db.baseline.findFirst({
    where: { creatorHandle: handle!, platform: 'tiktok' },
    select: { medianViews: true },
  });
  const weekVideos = await db.video.findMany({
    where: { sourceId: self.id, isBaselineSample: false, postedAt: { gte: since, lte: now } },
    select: { id: true, url: true, postedAt: true, caption: true, views: true, score: { select: { outlierScore: true } } },
    orderBy: { postedAt: 'desc' },
  });
  const totalOnSelf = await db.video.count({ where: { sourceId: self.id, isBaselineSample: false } });
  const latest = await db.video.findFirst({
    where: { sourceId: self.id, isBaselineSample: false },
    select: { postedAt: true },
    orderBy: { postedAt: 'desc' },
  });
  const medianViews = baseline?.medianViews ?? null;

  const rows: RetroRow[] = weekVideos.map((v) => ({
    id: v.id,
    url: v.url,
    postedAt: v.postedAt.toISOString(),
    caption: (v.caption || '').slice(0, 140),
    views: v.views,
    outlierScore: v.score?.outlierScore ?? null,
    vsMedian: medianViews && medianViews > 0 ? Number((v.views / medianViews).toFixed(2)) : null,
  }));

  const withRatio = rows.filter((r) => r.vsMedian != null) as Array<RetroRow & { vsMedian: number }>;
  const best = withRatio.slice().sort((a, b) => b.vsMedian - a.vsMedian)[0] ?? null;
  const worst = withRatio.slice().sort((a, b) => a.vsMedian - b.vsMedian)[0] ?? null;
  const needsResync = totalOnSelf === 0;

  let headline: string;
  if (needsResync) {
    headline = `Tracking @${handle}, but there are no videos yet — resync your account.`;
  } else if (rows.length === 0) {
    headline = latest
      ? `No posts from @${handle} this week. Last one was ${latest.postedAt.toISOString().slice(0, 10)}.`
      : `No posts from @${handle} this week.`;
  } else if (best && best.vsMedian >= 1) {
    const clip = best.caption ? `“${best.caption.slice(0, 48)}${best.caption.length > 48 ? '…' : ''}”` : 'A post';
    headline = `${clip} did ${best.vsMedian.toFixed(1)}× your median`
      + (worst && worst.id !== best.id && worst.vsMedian < 1 ? `; another sat at ${worst.vsMedian.toFixed(1)}×.` : '.');
  } else if (best) {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} this week — none beat your median (best ${best.vsMedian.toFixed(1)}×).`;
  } else {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} from @${handle} this week.`;
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    needsAccount: false,
    needsResync,
    selfSourceId: self.id,
    selfHandle: handle,
    videoCount: totalOnSelf,
    medianViews,
    lastPostedAt: latest?.postedAt.toISOString() ?? null,
    // When the feed went quiet, this says whether the silence could just be
    // a stale scrape rather than an actual quiet week.
    selfLastRefreshedAt: self.lastRefreshedAt?.toISOString() ?? null,
    headline,
    rows,
  };
}
