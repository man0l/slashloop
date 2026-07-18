// ---------------------------------------------------------------------------
// MCP Tools: Feed + Discover
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { formatNumber } from '../scoring.js';
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

      // Base query with score join
      const videos = await db.video.findMany({
        where,
        include: {
          score: true,
          source: { select: { id: true, query: true, nicheTag: true, platform: true } },
          analyses: { select: { id: true, analysisBasis: true, backend: true } },
          _count: { select: { hooks: true } },
        },
        orderBy: sortBy === 'newest' ? { postedAt: 'desc' }
          : sortBy === 'most_views' ? { views: 'desc' }
          : undefined,
        take: limit + 50, // Over-fetch for client-side filtering
        skip: offset,
      });

      // Client-side filters (engagement rate, min views, min score, analysis status)
      let filtered = videos;

      if (minViews) filtered = filtered.filter(v => v.views >= minViews);
      if (minOutlierScore) filtered = filtered.filter(v => v.score && v.score.outlierScore >= minOutlierScore);
      if (minEngagementRate) {
        const rate = minEngagementRate / 100;
        filtered = filtered.filter(v => v.views > 0 && (v.likes / v.views) >= rate);
      }
      if (analyzedOnly) filtered = filtered.filter(v => v.analyses.length > 0);
      if (unanalyzedOnly) filtered = filtered.filter(v => v.analyses.length === 0);

      // Sort by outlier score if that's the default
      if (sortBy === 'outlier_score') {
        filtered.sort((a, b) => (b.score?.outlierScore ?? 0) - (a.score?.outlierScore ?? 0));
      }

      // Paginate after filtering
      const paginated = filtered.slice(0, limit);
      const totalCount = filtered.length;

      const feed = paginated.map(v => {
        const engRate = v.views > 0 ? ((v.likes + v.comments + (v.shares ?? 0)) / v.views * 100).toFixed(1) : '0';
        return {
          id: v.id,
          platform: v.platform,
          creatorHandle: v.creatorHandle,
          creatorFollowers: v.creatorFollowers,
          caption: v.caption.slice(0, 200),
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
          pagination: { limit, offset, total: totalCount, hasMore: totalCount > offset + limit },
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
        take: 20,
      });

      const analyzed = await db.analysis.count({ where: { video: wsFilter } });
      const hooks = await db.hook.count({ where: { video: wsFilter } });
      const ideas = await db.idea.count({ where: { video: wsFilter } });
      const briefs = await db.brief.count({ where: { analysis: { video: wsFilter } } });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          overview: {
            totalVideos,
            analyzedVideos: analyzed,
            totalOutliers: outliers.length,
            hooksExtracted: hooks,
            ideasCreated: ideas,
            briefsGenerated: briefs,
          },
          topOutliers: outliers.map(s => ({
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