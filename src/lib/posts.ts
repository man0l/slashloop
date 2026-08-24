// ---------------------------------------------------------------------------
// Logged posts + weekly retro.
//
// The owner records what they actually published (URL, hook variation, which
// outlier they remade). We match the TikTok id against videos on the self
// source when a refresh has already pulled it, then the weekly retro can
// say "your remake of @x did 0.4× your median" instead of just listing URLs.
// ---------------------------------------------------------------------------

import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { normalizeQuery } from './canonical-query.js';

const RETRO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function tiktokVideoIdFromUrl(url: string): string | null {
  const m = String(url).match(/\/(?:video|photo|v)\/(\d{6,})/) ?? String(url).match(/(\d{15,})/);
  return m?.[1] ?? null;
}

export interface LogPostInput {
  url: string;
  postedAt?: string;
  hookVariation?: string;
  notes?: string;
  ideaId?: string;
  outlierVideoId?: string;
}

export async function logPostForWorkspace(workspace: Workspace, input: LogPostInput) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false as const, error: 'url_required', message: 'A TikTok URL is required.' };
  }
  const externalId = tiktokVideoIdFromUrl(url);
  const postedAt = input.postedAt ? new Date(input.postedAt) : new Date();
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false as const, error: 'invalid_posted_at', message: 'postedAt is not a valid date.' };
  }

  const self = await db.source.findFirst({
    where: { workspaceId: workspace.id, isSelf: true, sourceType: 'creator' },
    select: { id: true, query: true },
  });
  let videoId: string | null = null;
  if (externalId) {
    const match = await db.video.findFirst({
      where: {
        platform: 'tiktok',
        externalId,
        source: { workspaceId: workspace.id },
        ...(self ? { sourceId: self.id } : {}),
      },
      select: { id: true },
    });
    videoId = match?.id ?? null;
    if (!videoId) {
      const any = await db.video.findFirst({
        where: { platform: 'tiktok', externalId, source: { workspaceId: workspace.id } },
        select: { id: true },
      });
      videoId = any?.id ?? null;
    }
  }

  let outlierVideoId = input.outlierVideoId || null;
  if (outlierVideoId) {
    const owned = await db.video.findFirst({
      where: { id: outlierVideoId, source: { workspaceId: workspace.id } },
      select: { id: true },
    });
    if (!owned) outlierVideoId = null;
  }

  try {
    const post = await db.loggedPost.create({
      data: {
        workspaceId: workspace.id,
        url,
        externalId,
        postedAt,
        hookVariation: String(input.hookVariation || '').slice(0, 280),
        notes: String(input.notes || '').slice(0, 1000),
        ideaId: input.ideaId || null,
        videoId,
        outlierVideoId,
      },
    });
    if (input.ideaId) {
      await db.idea.updateMany({
        where: { id: input.ideaId, video: { source: { workspaceId: workspace.id } } },
        data: { status: 'tested' },
      });
    }
    return { ok: true as const, post: serializePost(post) };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { ok: false as const, error: 'duplicate_url', message: 'That URL is already in the post log.' };
    }
    throw err;
  }
}

export async function listPostsForWorkspace(workspace: Workspace, limit = 50) {
  const rows = await db.loggedPost.findMany({
    where: { workspaceId: workspace.id },
    include: {
      video: { select: { id: true, views: true, score: { select: { outlierScore: true } } } },
      outlier: { select: { id: true, creatorHandle: true, score: { select: { outlierScore: true } } } },
    },
    orderBy: { postedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map(serializeListed);
}

export interface RetroRow {
  id: string;
  url: string;
  postedAt: string;
  hookVariation: string;
  views: number | null;
  outlierScore: number | null;
  vsMedian: number | null;
  matched: boolean;
  remakeOf: string | null;
}

export async function buildWeeklyRetro(workspace: Workspace, now = new Date()) {
  const since = new Date(now.getTime() - RETRO_WINDOW_MS);
  const posts = await db.loggedPost.findMany({
    where: { workspaceId: workspace.id, postedAt: { gte: since, lte: now } },
    include: {
      video: { select: { views: true, creatorHandle: true, score: { select: { outlierScore: true } } } },
      outlier: { select: { creatorHandle: true, score: { select: { outlierScore: true } } } },
    },
    orderBy: { postedAt: 'desc' },
  });

  const self = await db.source.findFirst({
    where: { workspaceId: workspace.id, isSelf: true, sourceType: 'creator' },
    select: { query: true },
  });
  const handle = self ? normalizeQuery('creator', self.query) : null;
  const baseline = handle
    ? await db.baseline.findFirst({
        where: { creatorHandle: handle, platform: 'tiktok' },
        select: { medianViews: true, sampleSize: true },
      })
    : null;
  const medianViews = baseline?.medianViews ?? null;

  const rows: RetroRow[] = posts.map((p) => {
    const views = p.video?.views ?? null;
    const vsMedian = views != null && medianViews && medianViews > 0
      ? Number((views / medianViews).toFixed(2))
      : null;
    return {
      id: p.id,
      url: p.url,
      postedAt: p.postedAt.toISOString(),
      hookVariation: p.hookVariation,
      views,
      outlierScore: p.video?.score?.outlierScore ?? null,
      vsMedian,
      matched: Boolean(p.videoId),
      remakeOf: p.outlier?.creatorHandle ?? null,
    };
  });

  const matched = rows.filter((r) => r.matched);
  const withRatio = matched.filter((r) => r.vsMedian != null) as Array<RetroRow & { vsMedian: number }>;
  const best = withRatio.slice().sort((a, b) => b.vsMedian - a.vsMedian)[0] ?? null;
  const worst = withRatio.slice().sort((a, b) => a.vsMedian - b.vsMedian)[0] ?? null;

  let headline = 'No posts logged this week.';
  if (rows.length === 0) {
    headline = 'No posts logged this week — add what you published to start the retro.';
  } else if (!self) {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} logged. Mark your TikTok as “my account” so we can score them against your median.`;
  } else if (matched.length === 0) {
    headline = `${rows.length} post${rows.length === 1 ? '' : 's'} logged, none matched to your scraped videos yet — refresh your account.`;
  } else if (best && best.vsMedian >= 1) {
    headline = `${best.hookVariation || 'A remake'} did ${best.vsMedian.toFixed(1)}× your median`
      + (best.remakeOf ? ` (remake of @${best.remakeOf})` : '')
      + (worst && worst.id !== best.id && worst.vsMedian < 1 ? `; ${worst.hookVariation || 'another'} flopped at ${worst.vsMedian.toFixed(1)}×.` : '.');
  } else if (best) {
    headline = `Logged ${matched.length} matched post${matched.length === 1 ? '' : 's'} — none beat your median this week (best ${best.vsMedian.toFixed(1)}×).`;
  } else {
    headline = `${matched.length} of ${rows.length} logged posts matched your account.`;
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    logged: rows.length,
    matched: matched.length,
    medianViews,
    selfHandle: handle,
    headline,
    rows,
  };
}

function serializePost(p: { id: string; url: string; externalId: string | null; postedAt: Date; hookVariation: string; notes: string; ideaId: string | null; videoId: string | null; outlierVideoId: string | null; createdAt: Date }) {
  return {
    id: p.id,
    url: p.url,
    externalId: p.externalId,
    postedAt: p.postedAt.toISOString(),
    hookVariation: p.hookVariation,
    notes: p.notes,
    ideaId: p.ideaId,
    videoId: p.videoId,
    outlierVideoId: p.outlierVideoId,
    createdAt: p.createdAt.toISOString(),
  };
}

function serializeListed(p: {
  id: string; url: string; externalId: string | null; postedAt: Date; hookVariation: string; notes: string;
  ideaId: string | null; videoId: string | null; outlierVideoId: string | null; createdAt: Date;
  video: { id: string; views: number; score: { outlierScore: number } | null } | null;
  outlier: { id: string; creatorHandle: string; score: { outlierScore: number } | null } | null;
}) {
  return {
    ...serializePost(p),
    views: p.video?.views ?? null,
    outlierScore: p.video?.score?.outlierScore ?? null,
    remakeOf: p.outlier ? { id: p.outlier.id, creatorHandle: p.outlier.creatorHandle, outlierScore: p.outlier.score?.outlierScore ?? null } : null,
  };
}
