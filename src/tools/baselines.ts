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
import { withNextSteps, refreshCreditLabel, scraperCostLabel } from '../lib/next-steps.js';
import { enqueueRescoreJob, dispatchWorker } from '../lib/jobs.js';
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
      screenOnly: z.boolean().default(false)
        .describe('Free triage: score EVERY estimated outlier for suspicion and report, ignoring `limit`. '
          + 'Spends nothing and creates nothing. Use first when there are more candidates than credits.'),
    },
    async ({ minOutlierScore, limit, videosPerCreator, dryRun, screenOnly }) => {
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
      // Explicitly typed and coerced: Prisma's groupBy _count widens to `{}`
      // under some client generations, which silently poisons every comparison
      // downstream.
      const historyCount = new Map<string, number>(
        historyRows.map(r => [`${r.creatorHandle}__${r.platform}`, Number(r._count?._all ?? 0)] as const),
      );

      // Creators we already track — re-creating those would just duplicate.
      const existingCreatorSources = await db.source.findMany({
        where: { workspaceId: workspace.id, sourceType: 'creator' },
        select: { id: true, query: true, platform: true },
      });
      const tracked = new Map<string, string>(
        existingCreatorSources.map(s => [`${s.query}__${s.platform}`, s.id] as const),
      );

      // One entry per creator, keeping their single best estimated outlier.
      const seen = new Set<string>();
      const scored: Array<{
        creatorHandle: string;
        platform: string;
        topOutlierScore: number;
        topVideoId: string;
        views: number;
        followers: number | null;
        viewsPerFollower: number | null;
        suspicion: number | null;
        verdict: string;
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

        const followers: number | null = s.video.creatorFollowers ?? null;
        const vpf = followers && followers > 0
          ? Math.round((s.video.views / followers) * 10) / 10
          : null;

        // Rank by DISAGREEMENT between the two signals, not by score.
        //
        // Measured on four paid checks: wherever the estimated score and the
        // follower ratio agreed, the score survived being re-measured against
        // the creator's own median (510->563, 273->295, 169->167). The one case
        // where they disagreed was the only false positive, and the only
        // purchase that taught anything: @mikaylanogueira, 438x estimated on a
        // ratio of 0.3, collapsed to 1.3x — 17.4M followers reaching 5.7M
        // views, which is normal for her.
        //
        // So a high estimated score on a creator who UNDER-reaches their own
        // audience is the shape of a score that is lying. Ranking by score
        // alone spends credits confirming things the free ratio already
        // implied.
        const suspicion = vpf != null && vpf > 0
          ? Math.round((s.outlierScore / vpf) * 10) / 10
          : null;

        const verdict = vpf == null
          ? 'unknown — no follower count, ratio cannot be computed'
          : vpf < 1
            ? 'LIKELY FALSE POSITIVE — reaches fewer viewers than they have followers'
            : vpf < 10
              ? 'suspect — modest reach relative to audience size'
              : 'probably real — reach far exceeds follower count';

        scored.push({
          creatorHandle: s.video.creatorHandle,
          platform: s.video.platform,
          topOutlierScore: s.outlierScore,
          topVideoId: s.video.id,
          views: s.video.views,
          followers,
          viewsPerFollower: vpf,
          suspicion,
          verdict,
          source: s.video.source.query,
          videosHeld: held,
          alreadyTrackedSourceId: tracked.get(key) ?? null,
        });
      }

      // Most suspicious first. Nulls (no follower data) sort last: without a
      // ratio there is nothing to disagree with, so they are the weakest use of
      // credits, not the strongest.
      scored.sort((a, b) => (b.suspicion ?? -1) - (a.suspicion ?? -1));

      const candidates = scored.slice(0, limit);

      const perCreatorCost = `${scraperCostLabel(videosPerCreator)} + ${refreshCreditLabel(videosPerCreator)}`;
      const totalCredits = Math.ceil(videosPerCreator * 1.5) * candidates.length;

      // Free triage. With 43 estimated outliers and a 15-credit check each,
      // brute force costs 645 credits — so the useful question is not "which is
      // the biggest score" but "which scores should I not believe". This
      // answers that for nothing.
      if (screenOnly) {
        const likelyFalse = scored.filter(c => c.viewsPerFollower != null && c.viewsPerFollower < 1);
        const suspect = scored.filter(c => c.viewsPerFollower != null && c.viewsPerFollower >= 1 && c.viewsPerFollower < 10);
        const probablyReal = scored.filter(c => c.viewsPerFollower != null && c.viewsPerFollower >= 10);
        const unknown = scored.filter(c => c.viewsPerFollower == null);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
            message: `Screened ${scored.length} estimated outlier(s) for free. Nothing spent, nothing created.`,
            screenOnly: true,
            howToRead:
              'viewsPerFollower is reach measured against the creator\'s own audience, and it costs nothing. '
              + 'Below 1 means the video reached fewer people than the creator has followers — a high estimated '
              + 'score on top of that is almost certainly an artefact of the source median, not a breakout. '
              + 'Verified on four paid checks: the three where both signals agreed all held up when re-measured; '
              + 'the one that disagreed (438x estimated, 0.3 ratio) collapsed to 1.3x.',
            spendGuidance:
              'Spend on the likelyFalsePositive group first — those are the scores distorting the ranking, and '
              + 'confirming them is the only thing the free signal cannot do. Creators in probablyReal can be '
              + 'left alone: paying to confirm what the ratio already implies buys very little.',
            counts: {
              likelyFalsePositive: likelyFalse.length,
              suspect: suspect.length,
              probablyReal: probablyReal.length,
              noFollowerData: unknown.length,
            },
            costToCheckAll: `${Math.ceil(videosPerCreator * 1.5) * scored.length} credits`,
            costToCheckLikelyFalseOnly: `${Math.ceil(videosPerCreator * 1.5) * likelyFalse.length} credits`,
            likelyFalsePositive: likelyFalse,
            suspect,
            probablyReal: probablyReal.slice(0, 10),
            noFollowerData: unknown.slice(0, 10),
          }, [
            likelyFalse.length > 0 ? {
              label: `Check the ${likelyFalse.length} likely false positive(s)`,
              tool: 'deepen_baselines',
              args: { minOutlierScore, limit: likelyFalse.length, videosPerCreator, dryRun: true },
              cost: `${Math.ceil(videosPerCreator * 1.5) * likelyFalse.length} credits if you proceed past the dry run`,
              spendsMoney: true,
              why: 'These are ranked most-suspicious-first, so the default order already targets them. '
                + 'Quote the total and confirm before running any refresh.',
            } : null,
          ]), null, 2) }],
        };
      }

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
            estimatedTotal: `${totalCredits} credits + ${scraperCostLabel(videosPerCreator * candidates.length)}`,
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
            cost: `${totalCredits} credits + ${scraperCostLabel(videosPerCreator * candidates.length)} across ${candidates.length} refresh(es)`,
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

      // Above this many sources, rescoring inline does not fit the request
      // budget. Measured: a 15-source workspace (~450 videos, each a baseline
      // lookup plus an upsert) timed the client out at 180s and applied only
      // partially — the same wall-clock failure this tool exists to recover
      // from. Past the threshold it queues one job per source instead.
      const INLINE_RESCORE_MAX_SOURCES = 3;

      if (targets.length > INLINE_RESCORE_MAX_SOURCES) {
        const queued: string[] = [];
        for (const id of targets) {
          const job = await enqueueRescoreJob({
            workspaceId: workspace.id,
            sourceId: id,
            payload: {}, // no creatorHandle → the worker rescores just this source
          });
          queued.push(job.id);
        }
        await dispatchWorker('rescore');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: `Queued ${queued.length} rescore job(s) — one per source. Free, no spend.`,
            queuedJobs: queued.length,
            sources: targets.length,
            note: `More than ${INLINE_RESCORE_MAX_SOURCES} sources cannot be rescored inside one request, so they `
              + 'run on the queue instead. They drain within a minute or two. Re-read get_outlier_summary after '
              + 'that rather than immediately — an early read reports the old scores.',
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
