// ---------------------------------------------------------------------------
// Weekly retro — Studio, read-only over the owner's own feed(s).
//
// There is no post log. The workspace's isSelf creator sources ARE the record
// of what the owner published (a workspace can flag several — a faceless page
// and a personal one, say): refresh_source pulls each TikTok feed like any
// other creator's, and this file scores those videos against the posting
// account's own baseline median. The empty state is a resync, never data entry.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { cacheKey, getOrFill } from './cache.js';
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
  // Cached 120s, keyed by UTC day — studio aggregates barely move intraday.
  return getOrFill(
    cacheKey(['retro', workspace.id, now.toISOString().slice(0, 10)]),
    120_000,
    () => buildWeeklyRetroUncached(workspace, now),
  );
}

async function buildWeeklyRetroUncached(workspace: Workspace, now: Date) {
  const since = new Date(now.getTime() - RETRO_WINDOW_MS);
  // Every flagged account, oldest first — the first one stays the "primary"
  // (selfSourceId / selfHandle) for callers that still expect a single handle.
  const selfSources = await db.source.findMany({
    where: { workspaceId: workspace.id, isSelf: true, sourceType: 'creator' },
    select: { id: true, query: true, lastRefreshedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const primary = selfSources[0] ?? null;
  const handles = selfSources.map((s) => normalizeQuery('creator', s.query));

  if (!primary) {
    return {
      since: since.toISOString(),
      until: now.toISOString(),
      needsAccount: true,
      needsResync: false,
      selfSourceId: null,
      selfHandle: null,
      selfSourceIds: [] as string[],
      selfHandles: [] as string[],
      resyncTargets: [] as Array<{ sourceId: string; handle: string }>,
      videoCount: 0,
      medianViews: null,
      lastPostedAt: null,
      selfLastRefreshedAt: null,
      headline: 'Mark a tracked creator as your account on Sources — Studio reads that feed. Nothing to log by hand.',
      rows: [] as RetroRow[],
    };
  }

  // Sequential on purpose: concurrent Prisma queries hang the D1 binding.
  // Each account is scored against its own baseline median — a faceless page
  // and a personal page have very different floors.
  const rows: RetroRow[] = [];
  let totalOnSelf = 0;
  let lastPostedAt: Date | null = null;
  let medianViews: number | null = null;
  const resyncTargets: Array<{ sourceId: string; handle: string }> = [];

  for (let i = 0; i < selfSources.length; i++) {
    const source = selfSources[i]!;
    const handle = handles[i]!;
    const baseline = await db.baseline.findFirst({
      where: { creatorHandle: handle, platform: 'tiktok' },
      select: { medianViews: true },
    });
    if (i === 0) medianViews = baseline?.medianViews ?? null;

    const weekVideos = await db.video.findMany({
      where: { sourceId: source.id, isBaselineSample: false, postedAt: { gte: since, lte: now } },
      select: { id: true, url: true, postedAt: true, caption: true, views: true, score: { select: { outlierScore: true } } },
      orderBy: { postedAt: 'desc' },
    });
    const totalOnAccount = await db.video.count({ where: { sourceId: source.id, isBaselineSample: false } });
    if (totalOnAccount === 0) resyncTargets.push({ sourceId: source.id, handle });
    totalOnSelf += totalOnAccount;

    for (const v of weekVideos) {
      const median = baseline?.medianViews ?? null;
      rows.push({
        id: v.id,
        url: v.url,
        postedAt: v.postedAt.toISOString(),
        caption: (v.caption || '').slice(0, 140),
        views: v.views,
        outlierScore: v.score?.outlierScore ?? null,
        vsMedian: median && median > 0 ? Number((v.views / median).toFixed(2)) : null,
      });
      if (!lastPostedAt || v.postedAt > lastPostedAt) lastPostedAt = v.postedAt;
    }
  }

  rows.sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
  const needsResync = totalOnSelf === 0;
  const handleLabel = handles.map((h) => `@${h}`).join(' + ');

  const withRatio = rows.filter((r) => r.vsMedian != null) as Array<RetroRow & { vsMedian: number }>;
  const best = withRatio.slice().sort((a, b) => b.vsMedian - a.vsMedian)[0] ?? null;
  const worst = withRatio.slice().sort((a, b) => a.vsMedian - b.vsMedian)[0] ?? null;

  let headline: string;
  if (needsResync) {
    headline = `Tracking ${handleLabel}, but there are no videos yet — resync your account.`;
  } else if (rows.length === 0) {
    headline = lastPostedAt
      ? `No posts from ${handleLabel} this week. Last one was ${lastPostedAt.toISOString().slice(0, 10)}.`
      : `No posts from ${handleLabel} this week.`;
  } else if (best && best.vsMedian >= 1) {
    const clip = best.caption ? `“${best.caption.slice(0, 48)}${best.caption.length > 48 ? '…' : ''}”` : 'A post';
    headline = `${clip} did ${best.vsMedian.toFixed(1)}× its account's median`
      + (worst && worst.id !== best.id && worst.vsMedian < 1 ? `; another sat at ${worst.vsMedian.toFixed(1)}×.` : '.');
  } else if (best) {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} this week — none beat their account's median (best ${best.vsMedian.toFixed(1)}×).`;
  } else {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} from ${handleLabel} this week.`;
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    needsAccount: false,
    needsResync,
    selfSourceId: primary.id,
    selfHandle: handles[0]!,
    selfSourceIds: selfSources.map((s) => s.id),
    selfHandles: handles,
    resyncTargets,
    videoCount: totalOnSelf,
    medianViews,
    lastPostedAt: lastPostedAt?.toISOString() ?? null,
    // When the feed went quiet, this says whether the silence could just be
    // a stale scrape rather than an actual quiet week.
    selfLastRefreshedAt: primary.lastRefreshedAt?.toISOString() ?? null,
    headline,
    rows,
  };
}
