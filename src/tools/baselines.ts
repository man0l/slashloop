// ---------------------------------------------------------------------------
// MCP Tool: deepen_baselines — turn `estimated` outliers into `actual` ones.
//
// The problem this solves. `actual` scores need CREATOR_BASELINE_MIN_SAMPLE (5)
// videos of history for that creator. A hashtag or keyword scrape returns ~30
// videos from ~30 DIFFERENT creators, so every one of them lands at
// sampleSize 1 and is scored against the SOURCE's median instead. That number
// mostly tracks account size: a 5M-follower account posting normally into a
// tracked hashtag scores in the hundreds, while a genuine breakout by a small
// creator can score lower. In a real workspace this was 43 of 48 outliers.
//
// The fix is targeted, not global. Fetching history for all ~200 hashtag
// creators would be absurd — most of those videos are not interesting. Instead
// we spend only on the creators behind the BIGGEST estimated outliers: pull
// their last N videos, which clears the sample threshold, and their outlier is
// rescored against their own median. The score either survives (a real
// breakout) or collapses (a big account being big) — and both answers are worth
// knowing before spending analysis credits.
//
// Deliberately does not scrape. It creates the creator sources and hands back
// the refresh calls to make, so all Apify spend continues to flow through
// refresh_source's existing cap checks, credit debits and refunds rather than
// through a second, parallel implementation.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { CREATOR_BASELINE_MIN_SAMPLE, batchScoreVideos } from '../scoring.js';
import { withNextSteps, apifyCostLabel, refreshCreditLabel } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Videos to pull per creator.
 *
 * The threshold is 5 TOTAL videos including the one already held, so 5 is the
 * floor. The default is higher because trimmedMedian() drops the top and bottom
 * of the sample — at exactly 5 a single freak video still moves the median a
 * lot. 10 costs ~15 credits per creator and gives a median worth trusting.
 */
const DEFAULT_VIDEOS_PER_CREATOR = 10;

export function registerBaselineTools(server: McpServer) {
  server.tool('deepen_baselines',
    'Convert the biggest `estimated` outliers into `actual` ones by pulling each creator\'s recent videos, '
    + 'so their score is measured against their OWN median instead of the source median. '
    + 'Use when outliers look inflated by account size, when the user asks why a score is estimated, '
    + 'or before spending analysis credits on hashtag/keyword discoveries. '
    + 'Defaults to a dry run: it reports the candidates and exact cost and changes nothing. '
    + 'Call again with dryRun=false to create the creator sources, then refresh each one.',
    {
      minOutlierScore: z.number().min(0).default(25)
        .describe('Only consider estimated outliers at or above this score (default 25).'),
      limit: z.number().min(1).max(20).default(5)
        .describe('Max creators to handle in one pass (default 5). Each one costs a refresh.'),
      videosPerCreator: z.number().min(CREATOR_BASELINE_MIN_SAMPLE).max(30).default(DEFAULT_VIDEOS_PER_CREATOR)
        .describe(`Videos to pull per creator (min ${CREATOR_BASELINE_MIN_SAMPLE}, default ${DEFAULT_VIDEOS_PER_CREATOR}).`),
      dryRun: z.boolean().default(true)
        .describe('true (default) = report candidates and cost only. false = create the creator sources.'),
    },
    async ({ minOutlierScore, limit, videosPerCreator, dryRun }) => {
      const workspace = await requireWorkspace();
      const wsFilter = { source: { workspaceId: workspace.id } };

      // Biggest estimated outliers first — these are the ones whose score is
      // most likely to be an artefact worth checking.
      const candidateScores = await db.score.findMany({
        where: { scoreType: 'estimated', outlierScore: { gte: minOutlierScore }, video: wsFilter },
        include: {
          video: {
            select: {
              id: true, creatorHandle: true, platform: true, views: true,
              creatorFollowers: true, url: true, source: { select: { query: true } },
            },
          },
        },
        orderBy: { outlierScore: 'desc' },
        take: 100,
      });

      // How much history each of those creators actually has right now. One
      // grouped query rather than a per-creator loop (the Supabase pooler drops
      // idle connections mid-batch — see computeCreatorBaselinesBatch).
      const handles = [...new Set(candidateScores.map(s => s.video.creatorHandle))];
      const historyRows = handles.length
        ? await db.video.groupBy({
            by: ['creatorHandle', 'platform'],
            where: { creatorHandle: { in: handles } },
            _count: { _all: true },
          })
        : [];
      const historyCount = new Map(
        historyRows.map(r => [`${r.creatorHandle}__${r.platform}`, r._count._all]),
      );

      // Creators we already track — re-creating those would just duplicate.
      const existingCreatorSources = await db.source.findMany({
        where: { workspaceId: workspace.id, sourceType: 'creator' },
        select: { id: true, query: true, platform: true },
      });
      const tracked = new Map(
        existingCreatorSources.map(s => [`${s.query}__${s.platform}`, s.id]),
      );

      // One entry per creator, keeping their single best estimated outlier.
      const seen = new Set<string>();
      const candidates: Array<{
        creatorHandle: string;
        platform: string;
        topOutlierScore: number;
        topVideoId: string;
        views: number;
        followers: number | null;
        viewsPerFollower: number | null;
        source: string;
        videosHeld: number;
        alreadyTrackedSourceId: string | null;
      }> = [];

      for (const s of candidateScores) {
        const key = `${s.video.creatorHandle}__${s.video.platform}`;
        if (seen.has(key)) continue;
        const held = historyCount.get(key) ?? 0;
        // Enough history already → its score would be `actual` on the next
        // rescore, so there is nothing to buy here.
        if (held >= CREATOR_BASELINE_MIN_SAMPLE) continue;
        seen.add(key);

        const followers = s.video.creatorFollowers;
        candidates.push({
          creatorHandle: s.video.creatorHandle,
          platform: s.video.platform,
          topOutlierScore: s.outlierScore,
          topVideoId: s.video.id,
          views: s.video.views,
          followers,
          viewsPerFollower: followers && followers > 0
            ? Math.round((s.video.views / followers) * 10) / 10
            : null,
          source: s.video.source.query,
          videosHeld: held,
          alreadyTrackedSourceId: tracked.get(key) ?? null,
        });
        if (candidates.length >= limit) break;
      }

      const perCreatorCost = `${apifyCostLabel(videosPerCreator)} + ${refreshCreditLabel(videosPerCreator)}`;
      const totalCredits = Math.ceil(videosPerCreator * 1.5) * candidates.length;

      if (candidates.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: `No estimated outliers at or above ${minOutlierScore}x whose creator lacks history.`,
            checked: candidateScores.length,
            meaning: 'Either those creators already have enough videos to be scored against themselves, '
              + 'or nothing scored that high. Lower minOutlierScore to widen the net.',
          }, null, 2) }],
        };
      }

      if (dryRun) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
            message: `${candidates.length} creator(s) behind big estimated outliers have too little history to score properly.`,
            dryRun: true,
            threshold: `A creator needs ${CREATOR_BASELINE_MIN_SAMPLE} videos before their score becomes 'actual'.`,
            videosPerCreator,
            costPerCreator: perCreatorCost,
            estimatedTotal: `${totalCredits} credits + ${apifyCostLabel(videosPerCreator * candidates.length)}`,
            candidates,
            whatHappensNext:
              'Creating a creator source and refreshing it gives each creator enough history for an `actual` '
              + 'score. Their outlier is then re-measured against their own median: it either holds up (a real '
              + 'breakout worth analysing) or collapses (a large account performing normally). '
              + 'viewsPerFollower is a rough advance hint — a high ratio usually survives the recheck.',
          }, [{
            label: `Set up baselines for ${candidates.length} creator(s)`,
            tool: 'deepen_baselines',
            args: { minOutlierScore, limit, videosPerCreator, dryRun: false },
            cost: `${totalCredits} credits + ${apifyCostLabel(videosPerCreator * candidates.length)} across ${candidates.length} refresh(es)`,
            spendsMoney: true,
            why: 'Creating the sources is free; each refresh is what costs. Quote the per-creator price and '
              + 'confirm before running them, and let the user drop any creator they do not care about.',
          }]), null, 2) }],
        };
      }

      // Not a dry run — create the creator sources. Still no spend: the scrape
      // happens in refresh_source, which owns the cap checks and credit debits.
      const created: Array<{ creatorHandle: string; sourceId: string; wasAlreadyTracked: boolean }> = [];
      for (const c of candidates) {
        if (c.alreadyTrackedSourceId) {
          created.push({ creatorHandle: c.creatorHandle, sourceId: c.alreadyTrackedSourceId, wasAlreadyTracked: true });
          continue;
        }
        const source = await db.source.create({
          data: {
            workspaceId: workspace.id,
            platform: c.platform,
            sourceType: 'creator',
            query: c.creatorHandle,
            language: 'en',
            videoLimit: videosPerCreator,
            refreshSchedule: 'manual',
            nicheTag: 'baseline',
          },
        });
        created.push({ creatorHandle: c.creatorHandle, sourceId: source.id, wasAlreadyTracked: false });
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Created ${created.filter(c => !c.wasAlreadyTracked).length} creator source(s). No spend yet.`,
          dryRun: false,
          videosPerCreator,
          costPerCreator: perCreatorCost,
          sources: created,
          howToFinish:
            'Call refresh_source once per sourceId below. Each refresh pulls that creator\'s recent videos '
            + 'and, because the refreshed source is a creator source, automatically rescores the hashtag and '
            + 'keyword sources that hold their outlier — so those flip from estimated to actual without a '
            + 'separate step.',
        }, created.map(c => ({
          label: `Pull ${videosPerCreator} videos for @${c.creatorHandle}`,
          tool: 'refresh_source',
          args: { sourceId: c.sourceId },
          cost: perCreatorCost,
          spendsMoney: true,
          why: `Builds @${c.creatorHandle}'s baseline so their outlier is scored against their own median. `
            + 'Confirm each refresh separately.',
        }))), null, 2) }],
      };
    });

  // -------------------------------------------------------------------------
  // rescore_sources — recompute scores without scraping.
  //
  // Exists because the automatic rescore inside refresh_source is not reliable.
  // That path runs at the END of a request whose Apify scrape has already
  // consumed most of the function's 60s maxDuration, so Vercel kills the
  // invocation before it fires: observed live, with the refresh billed and
  // completed (10 pulled, 9 new) while the outlier it was bought to re-measure
  // kept its stale `estimated` score.
  //
  // Recovering from that must not require paying for the scrape again, so this
  // is a separate, free, scrape-free tool. The inline rescore stays as a
  // best-effort fast path for small scrapes; this is the one to rely on.
  // -------------------------------------------------------------------------
  server.tool('rescore_sources',
    'Recompute outlier scores for tracked sources WITHOUT scraping. Free and fast — no Apify, no credits. '
    + 'Use after a refresh that added creator history (scores elsewhere go stale), after deepen_baselines, '
    + 'or whenever a video still reads `estimated` though its creator now has enough videos. '
    + 'Pass creatorHandle to rescore only the sources holding that creator\'s videos, sourceIds for specific '
    + 'ones, or neither to rescore every source in the workspace.',
    {
      creatorHandle: z.string().optional()
        .describe('Rescore only sources containing this creator\'s videos. Cheapest targeted option.'),
      sourceIds: z.array(z.string()).optional()
        .describe('Explicit source ids to rescore.'),
    },
    async ({ creatorHandle, sourceIds }) => {
      const workspace = await requireWorkspace();

      let targets: string[];
      if (sourceIds?.length) {
        const owned = await db.source.findMany({
          where: { id: { in: sourceIds }, workspaceId: workspace.id },
          select: { id: true },
        });
        targets = owned.map(s => s.id);
      } else if (creatorHandle) {
        const rows = await db.video.findMany({
          where: { creatorHandle, source: { workspaceId: workspace.id } },
          select: { sourceId: true },
          distinct: ['sourceId'],
        });
        targets = rows.map(r => r.sourceId);
      } else {
        const all = await db.source.findMany({
          where: { workspaceId: workspace.id },
          select: { id: true },
        });
        targets = all.map(s => s.id);
      }

      if (targets.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'Nothing to rescore — no matching sources in this workspace.',
            creatorHandle: creatorHandle ?? null,
          }, null, 2) }],
        };
      }

      const rescored: Array<{ sourceId: string; scored: number; actual: number; estimated: number }> = [];
      const errors: string[] = [];
      for (const id of targets) {
        try {
          const results = await batchScoreVideos(id);
          rescored.push({
            sourceId: id,
            scored: results.length,
            actual: results.filter(r => r.scoreType === 'actual').length,
            estimated: results.filter(r => r.scoreType === 'estimated').length,
          });
        } catch (err) {
          errors.push(`${id}: ${(err as Error).message}`);
        }
      }

      const totalActual = rescored.reduce((a, r) => a + r.actual, 0);
      const totalEstimated = rescored.reduce((a, r) => a + r.estimated, 0);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Rescored ${rescored.length} source(s). No spend.`,
          sourcesRescored: rescored.length,
          videosScored: rescored.reduce((a, r) => a + r.scored, 0),
          nowActual: totalActual,
          stillEstimated: totalEstimated,
          perSource: rescored,
          errors: errors.length ? errors : undefined,
          note: 'A video that moved from estimated to actual is now measured against its own creator\'s '
            + 'median. Compare the new score with the old one: holding up means a real breakout, collapsing '
            + 'toward 1x means the creator is simply large.',
        }, [
          totalActual > 0 ? {
            label: 'See the updated ranking',
            tool: 'get_outlier_summary',
            why: 'Free. Shows which scores survived being re-measured against their own creator.',
          } : null,
        ]), null, 2) }],
      };
    });
}
