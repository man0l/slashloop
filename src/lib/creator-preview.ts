// ---------------------------------------------------------------------------
// Creator hover preview for the site's Gallery — outliers + last 5 videos
// already sitting in the workspace (no live scrape).
//
// Hashtag/keyword hits land in the gallery; the creator-baseline scrape
// (CREATOR_HISTORY_EXTRA = 5) then pulls recent videos for scoring. Those
// two pools are exactly what the hover card shows, without another Apify run.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { normalizeQuery } from './canonical-query.js';
import { resolveThumbUrl } from './media.js';

/** Same threshold as the Gallery "MIN OUTLIER" dropdown's first step. */
export const CREATOR_PREVIEW_OUTLIER_MIN = 2;
export const CREATOR_PREVIEW_OUTLIER_TAKE = 4;
export const CREATOR_PREVIEW_RECENT_TAKE = 5;

export interface CreatorPreviewVideo {
  id: string;
  thumbUrl: string | null;
  views: number;
  outlierScore: number | null;
  caption: string;
  postedAt: number;
  url: string;
}

export interface CreatorPreview {
  handle: string;
  trackedSourceId: string | null;
  videoCount: number;
  outlierCount: number;
  followers: number | null;
  medianViews: number | null;
  outliers: CreatorPreviewVideo[];
  recent: CreatorPreviewVideo[];
}

const videoSelect = {
  id: true,
  caption: true,
  url: true,
  views: true,
  postedAt: true,
  thumbnailUrl: true,
  thumbKey: true,
  score: { select: { outlierScore: true } },
} as const;

type PreviewRow = {
  id: string;
  caption: string;
  url: string;
  views: number;
  postedAt: Date;
  thumbnailUrl: string;
  thumbKey: string | null;
  score: { outlierScore: number } | null;
};

export function emptyCreatorPreview(handle: string): CreatorPreview {
  return {
    handle,
    trackedSourceId: null,
    videoCount: 0,
    outlierCount: 0,
    followers: null,
    medianViews: null,
    outliers: [],
    recent: [],
  };
}

/** Prisma OR for matching a handle with or without a leading @, case-insensitive. */
export function creatorHandleWhere(handle: string) {
  const key = normalizeQuery('creator', handle);
  if (!key) return null;
  return {
    OR: [
      { creatorHandle: { equals: key, mode: 'insensitive' as const } },
      { creatorHandle: { equals: `@${key}`, mode: 'insensitive' as const } },
    ],
  };
}

export function toPreviewVideo(v: PreviewRow): CreatorPreviewVideo {
  return {
    id: v.id,
    thumbUrl: resolveThumbUrl(v),
    views: v.views,
    outlierScore: v.score?.outlierScore ?? null,
    caption: v.caption,
    postedAt: v.postedAt.getTime(),
    url: v.url,
  };
}

export function trackedCreatorSourceId(
  sources: Array<{ id: string; query: string }>,
  handle: string,
): string | null {
  const key = normalizeQuery('creator', handle);
  if (!key) return null;
  return sources.find((s) => normalizeQuery('creator', s.query) === key)?.id ?? null;
}

/**
 * Pull a workspace's already-scraped videos for one creator and shape the
 * hover card. Baseline-only samples (pulled for scoring, hidden from the
 * gallery) still count toward "last 5" — that's why we have them.
 */
export async function buildCreatorPreview(
  workspace: Pick<Workspace, 'id'>,
  rawHandle: string,
): Promise<CreatorPreview> {
  const handle = normalizeQuery('creator', rawHandle);
  if (!handle) return emptyCreatorPreview('');

  const handleWhere = creatorHandleWhere(handle);
  if (!handleWhere) return emptyCreatorPreview(handle);

  const scoped = { source: { workspaceId: workspace.id }, ...handleWhere };

  // Sequential on purpose: concurrent Prisma queries hang the D1 binding.
  const recent = await db.video.findMany({
    where: scoped,
    orderBy: { postedAt: 'desc' },
    take: CREATOR_PREVIEW_RECENT_TAKE,
    select: videoSelect,
  });
  const outliers = await db.video.findMany({
    where: { ...scoped, isBaselineSample: false, score: { isNot: null } },
    orderBy: { score: { outlierScore: 'desc' } },
    take: CREATOR_PREVIEW_OUTLIER_TAKE,
    select: videoSelect,
  });
  const videoCount = await db.video.count({ where: { ...scoped, isBaselineSample: false } });
  const outlierCount = await db.video.count({
    where: {
      ...scoped,
      isBaselineSample: false,
      score: { is: { outlierScore: { gte: CREATOR_PREVIEW_OUTLIER_MIN } } },
    },
  });
  const followerRow = await db.video.findFirst({
    where: { ...scoped, creatorFollowers: { not: null } },
    orderBy: { scrapedAt: 'desc' },
    select: { creatorFollowers: true },
  });
  const creatorSources = await db.source.findMany({
    where: { workspaceId: workspace.id, sourceType: 'creator' },
    select: { id: true, query: true },
  });
  const baseline = await db.baseline.findFirst({
    where: {
      platform: 'tiktok',
      ...handleWhere,
    },
    select: { medianViews: true },
  });

  return {
    handle,
    trackedSourceId: trackedCreatorSourceId(creatorSources, handle),
    videoCount,
    outlierCount,
    followers: followerRow?.creatorFollowers ?? null,
    medianViews: baseline?.medianViews ?? null,
    outliers: outliers.map(toPreviewVideo),
    recent: recent.map(toPreviewVideo),
  };
}
