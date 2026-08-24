// ---------------------------------------------------------------------------
// MCP Tools: Feed + Discover
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { formatNumber } from '../scoring.js';
import { resolveThumbUrl } from '../lib/media.js';
import { withNextSteps, analyzeCostLabel } from '../lib/next-steps.js';
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

      // Build where clause — always scoped to this user's workspace.
      // isBaselineSample rows are internal scoring history (creator-median
      // deepening): the gallery and digest exclude them, and an agent browsing
      // the feed must not see them as content either.
      const where: any = { source: { workspaceId: workspace.id }, isBaselineSample: false };
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

      const feed = paginated.map((v, i) => {
        const engRate = v.views > 0 ? ((v.likes + v.comments + (v.shares ?? 0)) / v.views * 100).toFixed(1) : '0';
        return {
          // 1-based position in THIS page — what "video 3" means when someone
          // references a result from this call. Resets each call rather than
          // following `offset`, since it names what's currently on screen.
          index: i + 1,
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
          sound: v.soundId ? { id: v.soundId, title: v.soundTitle, author: v.soundAuthor } : null,
        };
      });

      // Best value for analysis credits in the current result set: unanalyzed,
      // and scored against the creator's own baseline rather than a source
      // median. Drawn from the page the user is actually looking at.
      const analyzeCandidates = paginated
        .filter(v => v.analyses.length === 0 && v.score?.scoreType === 'actual')
        .slice(0, 5);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
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
        }, [
          feed.length > 0 ? {
            label: 'View these as a gallery',
            tool: 'show_gallery',
            args: { ...(sourceId ? { sourceId } : {}), ...(minOutlierScore ? { minOutlierScore } : {}) },
            why: 'Free. Thumbnails instead of JSON, with filters.',
          } : null,
          analyzeCandidates.length > 0 ? {
            label: `Analyze ${analyzeCandidates.length === 1 ? 'the one real outlier' : `the ${analyzeCandidates.length} real outliers`} here`,
            tool: 'analyze_video',
            args: { videoId: analyzeCandidates[0]!.id },
            cost: analyzeCostLabel(analyzeCandidates.length),
            spendsMoney: true,
            why: `Creator-relative scores: ${analyzeCandidates
              .map(v => `@${v.creatorHandle} ${v.score?.outlierScore.toFixed(0)}×`)
              .join(', ')}. Everything else on this page is scored against a source median, which mostly reflects account size.`,
          } : null,
          feed.length === 0 ? {
            label: 'Loosen the filters',
            tool: 'get_feed',
            why: `No videos matched. total=${totalCount} for these filters — try a lower minOutlierScore or minViews before assuming there is no data.`,
          } : null,
        ]), null, 2) }],
      };
    });

  // ---- search_library (was discover_search) ----
  //
  // Renamed because the old name was the product's most misleading moment. It
  // reads like live search; it only queries videos already scraped into this
  // workspace. A new user searches a term with an empty library, gets nothing,
  // and reasonably concludes the product is broken — when the real answer is
  // "track it, then refresh". The `discover_search` alias was removed when the
  // new `discover` tool (live, keyword-driven source discovery) took over the
  // discover name; use that for finding NEW sources, this for searching what
  // is already scraped.
  const searchLibrary = {
    description:
      'Search videos ALREADY pulled into this workspace by keyword, hashtag or creator handle. '
      + 'This does NOT hit the network and cannot find new content — an empty result means nothing '
      + 'matching has been scraped yet, not that nothing exists. To bring in new videos use create_source '
      + 'then refresh_source.',
    schema: {
      query: z.string().describe('Search query (keyword, hashtag, or creator handle)'),
      platform: z.enum(['tiktok', 'reels', 'shorts']).describe('Platform to search'),
    },
  };

  const searchLibraryHandler = async ({ query, platform }: { query: string; platform: 'tiktok' | 'reels' | 'shorts' }) => {
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
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
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
            ? `Searched videos already pulled into this workspace — this tool does NOT hit the network. Found ${existingVideos.length} match(es).`
            : `No API key configured for ${platform}. Searched existing data only; found ${existingVideos.length} match(es).`,
          // The empty result here is the product's most misleading moment: the
          // tool is named like live search but only queries what has already
          // been scraped, so a new workspace searches, gets nothing, and
          // concludes the product is broken. Never let that be the last word.
          emptyResultMeaning: existingVideos.length === 0
            ? `Zero matches does NOT mean nothing exists for "${query}" — it means nothing matching has been pulled into this workspace yet. Say that plainly, then offer to track it.`
            : undefined,
        }, [
          // Only offer tracking on a platform that can actually be scraped.
          // Suggesting a Reels source sends the user into create_source →
          // refresh → failure, which reads as a broken product rather than an
          // unfinished one.
          platform === 'tiktok' ? {
            label: `Track ${query} on ${platform}`,
            tool: 'create_source',
            args: {
              platform,
              sourceType: query.startsWith('#') ? 'hashtag' : query.startsWith('@') ? 'creator' : 'keyword',
              query,
            },
            why: existingVideos.length === 0
              ? 'Free. Nothing matching has been scraped yet — tracking it, then refreshing, is the only way to get results.'
              : 'Free. Keeps this search fed with new videos instead of a one-off look at old data.',
          } : {
            label: `Track ${query} on TikTok instead`,
            tool: 'create_source',
            args: {
              platform: 'tiktok',
              sourceType: query.startsWith('#') ? 'hashtag' : query.startsWith('@') ? 'creator' : 'keyword',
              query,
            },
            why: `Free. ${platform} has no scraper yet, so a ${platform} source would be created and then fail `
              + 'at refresh. TikTok is the only live platform — say so plainly rather than letting the user '
              + 'discover it two steps later.',
          },
        ]), null, 2) }],
      };
  };

  server.tool('search_library', searchLibrary.description, searchLibrary.schema, searchLibraryHandler);

  // The old name for search_library was `discover_search` (removed once the
  // real `discover` tool — keyword-driven source discovery — took the name).
  // History: the rename happened because "discover_search" read like live
  // search while it only queries already-scraped videos.

  // ---- get_outlier_summary ----
  server.tool('get_outlier_summary',
    'Get a summary of outlier activity across all tracked sources. Useful for weekly reviews.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      // Baseline samples are internal scoring history, not content — same
      // exclusion as get_feed / buildCards / buildDigest, so the summary's
      // counts and top list describe the videos an agent can actually act on.
      const wsFilter = { source: { workspaceId: workspace.id }, isBaselineSample: false };

      const totalVideos = await db.video.count({ where: wsFilter });
      const outliers = await db.score.findMany({
        where: {
          outlierScore: { gte: 5 },
          video: wsFilter,
        },
        include: {
          video: { select: { id: true, creatorHandle: true, creatorFollowers: true, platform: true, views: true, postedAt: true, source: { select: { query: true } } } },
        },
        orderBy: { outlierScore: 'desc' },
        take: 50, // over-fetch so we can rank actual-first after the cut
      });

      // `actual` outliers (real creator baseline) are the trustworthy signal.
      // `estimated` (limited creator history) can be high-multiple noise, so
      // rank them below actual in the displayed top list.
      const actualCount = await db.score.count({ where: { outlierScore: { gte: 5 }, scoreType: 'actual', video: wsFilter } });
      const estimatedCount = await db.score.count({ where: { outlierScore: { gte: 5 }, scoreType: 'estimated', video: wsFilter } });

      // Third tier: estimated scores on creators who reached fewer people than
      // follow them. An honest explanation is not enough on its own — a video
      // labelled "unverified" that still sits second in the list is still being
      // recommended. @mikaylanogueira ranked #2 at 438x and was actually 1.3x.
      //
      // Free: creatorFollowers is selected above, no extra query.
      const underReaches = (s: typeof outliers[number]) => {
        const f = s.video.creatorFollowers;
        return s.scoreType === 'estimated' && !!f && f > 0 && s.video.views / f < 1;
      };
      const ranked = [
        ...outliers.filter(s => s.scoreType === 'actual'),
        ...outliers.filter(s => s.scoreType === 'estimated' && !underReaches(s)),
        ...outliers.filter(underReaches),
      ].slice(0, 20);
      const underReachCount = outliers.filter(underReaches).length;

      const analyzed = await db.analysis.count({ where: { video: wsFilter } });
      const hooks = await db.hook.count({ where: { video: wsFilter } });
      const ideas = await db.idea.count({ where: { video: wsFilter } });
      const briefs = await db.brief.count({ where: { analysis: { video: wsFilter } } });

      // The unanalyzed, creator-relative outliers — what credits are best spent
      // on. Read off `ranked`, which already puts actual before estimated.
      const analyzedIds = new Set(
        (await db.analysis.findMany({
          where: { video: wsFilter },
          select: { videoId: true },
          distinct: ['videoId'],
        })).map(a => a.videoId),
      );
      const unanalyzedActual = ranked
        .filter(s => s.scoreType === 'actual' && !analyzedIds.has(s.video.id))
        .slice(0, 5);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
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
          // Without this, a 272× estimated score reads as more impressive than
          // a 686× actual one purely because it sits on a bigger view count.
          scoreTypeNote:
            '`actual` = measured against that creator\'s own median, the trustworthy signal. '
            + '`estimated` = measured against the source\'s median, which largely tracks account size — '
            + 'a huge account posting normally into a tracked hashtag scores high. '
            + 'Lead with actual scores when summarising or recommending.',
          ...(underReachCount > 0 ? {
            underReachWarning:
              `${underReachCount} estimated outlier(s) are ranked LAST because the creator reached fewer people `
              + 'than follow them — normal performance for their audience size, not a breakout. Their explanation '
              + 'starts with ⚠️. Do not recommend analysing these ahead of the actual-score ones; verified example: '
              + 'a 438x estimated score in this workspace turned out to be 1.3x.',
          } : {}),
          topOutliers: ranked.map((s, i) => ({
            index: i + 1,
            videoId: s.video.id,
            creator: s.video.creatorHandle,
            platform: s.video.platform,
            source: s.video.source.query,
            views: s.video.views,
            outlierScore: s.outlierScore,
            scoreType: s.scoreType,
            postedAt: s.video.postedAt.toISOString(),
            explanation: s.explanation,
            // Without this a caller cannot tell an already-analysed video from
            // a fresh one, so an unattended digest recommends the same video
            // every single morning. Observed: a scheduled run proposed
            // analysing a video that had been analysed AND hook-extracted.
            hasAnalysis: analyzedIds.has(s.video.id),
          })),
        }, [
          // A digest should recommend what is still worth doing. Without
          // hasAnalysis on each entry above, an unattended run has no way to
          // tell, and repeats yesterday's recommendation forever.
          unanalyzedActual.length > 0 ? {
            label: `Analyze the ${unanalyzedActual.length} real outlier${unanalyzedActual.length === 1 ? '' : 's'}`,
            tool: 'analyze_video',
            args: { videoId: unanalyzedActual[0]!.video.id },
            cost: analyzeCostLabel(unanalyzedActual.length),
            spendsMoney: true,
            why: `${unanalyzedActual.map(s => `@${s.video.creatorHandle} ${s.outlierScore.toFixed(0)}×`).join(', ')}`
              + ` — creator-relative and not yet analyzed. ${analyzed === 0
                ? 'Nothing in this workspace has been analyzed yet, so hooks, ideas and briefs are all still empty.'
                : ''}`,
          } : null,
          // When estimated scores dominate, the top of the list is mostly
          // account size — the deepen_baselines flow exists precisely for
          // this and used to require already knowing about it. Offer the free
          // triage first; its dry run then quotes the exact refresh cost.
          // (Verified case: a 438× estimated score that was really 1.3×.)
          estimatedCount >= 3 && estimatedCount > actualCount ? {
            label: 'Verify the estimated scores before trusting them',
            tool: 'deepen_baselines',
            args: { screenOnly: true },
            why: `${estimatedCount} of ${actualCount + estimatedCount} outliers are scored against a source median, `
              + 'which mostly tracks account size. screenOnly:true is a free triage that ranks which scores are '
              + 'most likely to be inflated; the dry run after it quotes the exact credit cost to re-measure '
              + 'each against the creator\'s own median.',
          } : null,
          totalVideos > 0 ? {
            label: 'Browse the outliers visually',
            tool: 'show_gallery',
            args: { minOutlierScore: 10 },
            why: 'Free.',
          } : null,
          totalVideos === 0 ? {
            label: 'Track your first source',
            tool: 'create_source',
            why: 'Free. Nothing is tracked yet — this workspace is empty.',
          } : null,
        ]), null, 2) }],
      };
    });
}