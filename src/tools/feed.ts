// ---------------------------------------------------------------------------
// MCP Tools: Feed + Discover
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { formatNumber } from '../scoring.js';
import { resolveThumbUrl } from '../lib/media.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerFeedTools(server: McpServer) {

  // ---- get_feed ----
  server.tool('get_feed',
    'Get the ranked feed of videos from tracked sources. Videos are sorted by outlier score by default.',
    {
      platform: z.enum(['tiktok', 'reels', 'shorts']).optional(),
      sourceId: z.string().optional(),
      search: z.string().optional().describe('Search in caption or creator handle'),
      minViews: z.number().optional(),
      minOutlierScore: z.number().optional(),
      minEngagementRate: z.number().optional().describe('Minimum engagement rate as percentage (e.g. 3.0 for 3%)'),
      postedAfter: z.string().optional().describe('ISO date string, only videos after this date'),
      postedBefore: z.string().optional().describe('ISO date string, only videos before this date'),
      analyzedOnly: z.boolean().optional().describe('If true, only show videos that have been AI-analyzed'),
      unanalyzedOnly: z.boolean().optional().describe('If true, only show videos NOT yet analyzed'),
      sortBy: z.enum(['outlier_score', 'newest', 'most_views']).default('outlier_score'),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    },
    async (params) => {
      const {
        platform, sourceId, search, minViews, minOutlierScore,
        minEngagementRate, postedAfter, postedBefore,
        analyzedOnly, unanalyzedOnly, sortBy, limit, offset,
      } = params;

      const workspace = await requireWorkspace();

      // Build where clause — always scoped to this user's workspace
      const where: any = { source: { workspaceId: workspace.id } };
      if (platform) where.platform = platform;
      if (sourceId) where.sourceId = sourceId;
      if (search) where.OR = [
        { caption: { contains: search } },
        { creatorHandle: { contains: search } },
      ];
      if (postedAfter) where.postedAt = { ...where.postedAt, gte: new Date(postedAfter) };
      if (postedBefore) where.postedAt = { ...where.postedAt, lte: new Date(postedBefore) };

      // Filters that the DB can express belong in the DB.
      //
      // These used to run in memory over a `take: limit + 50` slice, which made
      // the result depend on whatever arbitrary order Postgres returned — and
      // when sortBy was 'outlier_score' there was no orderBy at all, so the
      // slice was effectively random. `minOutlierScore: 10` then reported 9
      // videos where show_gallery (which ranks in the DB) found 38: the filter
      // was scoring a random 74 rows, not the workspace.
      if (minViews) where.views = { gte: minViews };
      if (minOutlierScore) where.score = { outlierScore: { gte: minOutlierScore } };
      if (analyzedOnly) where.analyses = { some: {} };
      if (unanalyzedOnly) where.analyses = { none: {} };

      // Engagement rate is computed from two columns, so it stays in memory.
      // It is applied AFTER the DB has narrowed and ordered the set, so it only
      // ever trims the page — it can no longer silently redefine it.
      const inMemoryFilter = minEngagementRate != null;

      // True total for the filter set, not the size of an over-fetched window.
      const totalCount = await db.video.count({ where });

      const include = {
        score: true,
        source: { select: { id: true, query: true, nicheTag: true, platform: true } },
        // Newest first — lines below read analyses[0] as "the" analysis, and
        // unordered that is the oldest row, so a re-analysed video reports
        // its first basis/backend forever. Same bug as get_video had.
        analyses: {
          select: { id: true, analysisBasis: true, backend: true },
          orderBy: { createdAt: 'desc' as const },
        },
        _count: { select: { hooks: true } },
      };

      // Over-fetch only for the one filter that cannot be pushed down.
      const take = inMemoryFilter ? limit + 50 : limit;

      let videos;
      if (sortBy === 'newest' || sortBy === 'most_views') {
        videos = await db.video.findMany({
          where, include, take, skip: offset,
          orderBy: sortBy === 'newest' ? { postedAt: 'desc' } : { views: 'desc' },
        });
      } else {
        // Ranking by outlier score needs NULLS LAST — a video with no Score row
        // must not outrank a scored one. Postgres defaults DESC to NULLS FIRST,
        // and Prisma cannot express nulls ordering through a relation, so the
        // read is split: scored rows first (hitting @@index([outlierScore])),
        // unscored appended newest-first only if the page still has room.
        const hasScoreFilter = where.score !== undefined;
        const scoredWhere = hasScoreFilter ? where : { ...where, score: { isNot: null } };

        const scoredTotal = await db.video.count({ where: scoredWhere });
        const scored = offset < scoredTotal
          ? await db.video.findMany({
              where: scoredWhere, include, take, skip: offset,
              orderBy: { score: { outlierScore: 'desc' } },
            })
          : [];

        videos = scored;
        if (!hasScoreFilter && scored.length < take) {
          const unscored = await db.video.findMany({
            where: { ...where, score: { is: null } }, include,
            take: take - scored.length,
            skip: Math.max(0, offset - scoredTotal),
            orderBy: { postedAt: 'desc' },
          });
          videos = [...scored, ...unscored];
        }
      }

      let filtered = videos;
      if (minEngagementRate != null) {
        const rate = minEngagementRate / 100;
        filtered = filtered.filter(v => v.views > 0 && (v.likes / v.views) >= rate);
      }

      const paginated = filtered.slice(0, limit);

      const feed = paginated.map(v => {
        const engRate = v.views > 0 ? ((v.likes + v.comments + (v.shares ?? 0)) / v.views * 100).toFixed(1) : '0';
        return {
          id: v.id,
          platform: v.platform,
          creatorHandle: v.creatorHandle,
          creatorFollowers: v.creatorFollowers,
          caption: v.caption.slice(0, 200),
          // thumbUrl is what a UI should render: the stored copy when we have
          // one, the original source URL otherwise. thumbStatus lets a gallery
          // show a placeholder instead of a broken image once the retention
          // sweeper has removed the stored copy.
          thumbUrl: resolveThumbUrl(v),
          thumbStatus: v.thumbStatus,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          postedAt: v.postedAt.toISOString(),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          shares: v.shares,
          saves: v.saves,
          durationSec: v.durationSec,
          engagementRate: `${engRate}%`,
          score: v.score ? {
            outlierScore: v.score.outlierScore,
            scoreType: v.score.scoreType,
            explanation: v.score.explanation,
          } : null,
          hasAnalysis: v.analyses.length > 0,
          analysisBasis: v.analyses[0]?.analysisBasis ?? null,
          analysisBackend: v.analyses[0]?.backend ?? null,
          hookCount: v._count.hooks,
          source: { query: v.source.query, nicheTag: v.source.nicheTag },
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          feed,
          pagination: {
            limit,
            offset,
            total: totalCount,
            hasMore: totalCount > offset + limit,
            // `total` counts the DB-side filters. minEngagementRate is computed
            // per row and trims the page after the fact, so the true count is
            // at most this when it is set. Flagged rather than silently wrong.
            ...(minEngagementRate != null ? { totalIsUpperBound: true } : {}),
          },
          filters: { platform, sourceId, search, minViews, minOutlierScore, minEngagementRate, sortBy },
        }, null, 2) }],
      };
    });

  // ---- discover_search ----
  server.tool('discover_search',
    '[EXPERIMENTAL] One-off search across platforms. Live search (Apify for TikTok/Reels, YouTube Data API v3 for Shorts) is NOT yet wired up — this tool only filters existing videos already in the DB. To find new content, use create_source to track a creator/keyword/hashtag and wait for refresh_source to become live.',
    {
      query: z.string().describe('Search query (keyword, hashtag, or creator handle)'),
      platform: z.enum(['tiktok', 'reels', 'shorts']).describe('Platform to search'),
    },
    async ({ query, platform }) => {
      const workspace = await requireWorkspace();
      // In a full implementation, this would call the scraper APIs directly
      // For now, check if any existing videos match the search
      const existingVideos = await db.video.findMany({
        where: {
          platform,
          source: { workspaceId: workspace.id },
          OR: [
            { caption: { contains: query.replace('#', '') } },
            { creatorHandle: { contains: query.replace('@', '') } },
          ],
        },
        include: { score: true },
        take: 10,
        orderBy: { views: 'desc' },
      });

      const hasApiKey = platform === 'shorts'
        ? !!process.env.YOUTUBE_API_KEY
        : !!process.env.APIFY_API_KEY;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query,
          platform,
          results: existingVideos.length > 0 ? existingVideos.map(v => ({
            id: v.id,
            creatorHandle: v.creatorHandle,
            caption: v.caption.slice(0, 150),
            views: v.views,
            outlierScore: v.score?.outlierScore ?? null,
            postedAt: v.postedAt.toISOString(),
            url: v.url,
            isAlreadyTracked: true,
          })) : [],
          note: hasApiKey
            ? `Live search available for ${platform}. Found ${existingVideos.length} matching videos already in DB.`
            : `No API key configured for ${platform}. Showing ${existingVideos.length} matching videos from existing data. Set APIFY_API_KEY or YOUTUBE_API_KEY for live search.`,
          actions: {
            trackSource: `Use create_source with platform="${platform}", sourceType="keyword" or "hashtag", query="${query}" to track this search permanently.`,
            trackCreator: `Use create_source with sourceType="creator" and the specific @handle to track a creator.`,
          },
        }, null, 2) }],
      };
    });

  // ---- get_outlier_summary ----
  server.tool('get_outlier_summary',
    'Get a summary of outlier activity across all tracked sources. Useful for weekly reviews.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const wsFilter = { source: { workspaceId: workspace.id } };

      const totalVideos = await db.video.count({ where: wsFilter });
      const outliers = await db.score.findMany({
        where: {
          outlierScore: { gte: 5 },
          video: wsFilter,
        },
        include: {
          video: { select: { id: true, creatorHandle: true, platform: true, views: true, postedAt: true, source: { select: { query: true } } } },
        },
        orderBy: { outlierScore: 'desc' },
        take: 50, // over-fetch so we can rank actual-first after the cut
      });

      // `actual` outliers (real creator baseline) are the trustworthy signal.
      // `estimated` (limited creator history) can be high-multiple noise, so
      // rank them below actual in the displayed top list.
      const actualCount = await db.score.count({ where: { outlierScore: { gte: 5 }, scoreType: 'actual', video: wsFilter } });
      const estimatedCount = await db.score.count({ where: { outlierScore: { gte: 5 }, scoreType: 'estimated', video: wsFilter } });
      const ranked = [
        ...outliers.filter(s => s.scoreType === 'actual'),
        ...outliers.filter(s => s.scoreType === 'estimated'),
      ].slice(0, 20);

      const analyzed = await db.analysis.count({ where: { video: wsFilter } });
      const hooks = await db.hook.count({ where: { video: wsFilter } });
      const ideas = await db.idea.count({ where: { video: wsFilter } });
      const briefs = await db.brief.count({ where: { analysis: { video: wsFilter } } });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          overview: {
            totalVideos,
            analyzedVideos: analyzed,
            totalOutliers: actualCount + estimatedCount,
            actualOutliers: actualCount,
            estimatedOutliers: estimatedCount,
            hooksExtracted: hooks,
            ideasCreated: ideas,
            briefsGenerated: briefs,
          },
          topOutliers: ranked.map(s => ({
            videoId: s.video.id,
            creator: s.video.creatorHandle,
            platform: s.video.platform,
            source: s.video.source.query,
            views: s.video.views,
            outlierScore: s.outlierScore,
            scoreType: s.scoreType,
            postedAt: s.video.postedAt.toISOString(),
            explanation: s.explanation,
          })),
        }, null, 2) }],
      };
    });
}