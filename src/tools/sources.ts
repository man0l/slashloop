// ---------------------------------------------------------------------------
// MCP Tools: Source Management (CRUD + refresh)
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { scrapeSource } from '../lib/apify.js';
import { assertApifyCap, getApifyCapStatus, SpendCapExceededError } from '../lib/spend-cap.js';
import { batchScoreVideos } from '../scoring.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload } from '../lib/credits.js';
import { ingestThumbnails, type ThumbIngestTarget } from '../lib/media.js';
import { withNextSteps, apifyCostLabel, analyzeCostLabel, refreshCreditLabel } from '../lib/next-steps.js';
import { enqueueRefreshJob, enqueueRescoreJob, outstandingJobForSource, dispatchWorker } from '../lib/jobs.js';

/**
 * Largest refresh still run inline, in videos. Zero = always queue.
 *
 * This was 10, on the reasoning that a 10-video scrape "fits". It does not.
 * Two separate 10-video creator refreshes both timed the MCP client out at
 * 180s, and both had their cross-source rescore killed after the scrape had
 * already been billed — the precise half-completion the queue exists to stop.
 *
 * Worse, the threshold silently disabled the queue altogether: deepen_baselines
 * creates sources with videoLimit 10, and the test is `limit > 10`, so every
 * source it made missed the queue by one video.
 *
 * A scrape is an opaque call to a third party. Nothing about it is reliably
 * bounded, so there is no honest number here other than zero. `async: false`
 * remains available to force the old path when debugging.
 */
const INLINE_REFRESH_MAX_VIDEOS = 0;

/** How long callers should be willing to wait on a queued refresh. */
const REFRESH_JOB_DEADLINE_MS = 5 * 60_000;
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSourceTools(server: McpServer) {

  // ---- list_sources ----
  server.tool('list_sources',
    'List all tracked sources. Optional filters: platform, sourceType, isActive.',
    {
      platform: z.enum(['tiktok', 'reels', 'shorts']).optional(),
      sourceType: z.enum(['creator', 'keyword', 'hashtag']).optional(),
      isActive: z.boolean().optional(),
      nicheTag: z.string().optional(),
    },
    async ({ platform, sourceType, isActive, nicheTag }) => {
      const workspace = await requireWorkspace();
      const sources = await db.source.findMany({
        where: {
          workspaceId: workspace.id,
          platform,
          sourceType,
          isActive,
          nicheTag: nicheTag || undefined,
        },
        include: {
          _count: { select: { videos: true, refreshRuns: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sources.map(s => ({
          id: s.id,
          platform: s.platform,
          sourceType: s.sourceType,
          query: s.query,
          language: s.language,
          videoLimit: s.videoLimit,
          refreshSchedule: s.refreshSchedule,
          isActive: s.isActive,
          nicheTag: s.nicheTag,
          videoCount: s._count.videos,
          refreshCount: s._count.refreshRuns,
          lastRefreshedAt: s.lastRefreshedAt?.toISOString() ?? null,
          consecutiveFails: s.consecutiveFails,
          createdAt: s.createdAt.toISOString(),
        })), null, 2) }],
      };
    });

  // ---- get_source ----
  server.tool('get_source',
    'Get details of a single tracked source by ID.',
    { sourceId: z.string().describe('Source ID') },
    async ({ sourceId }) => {
      const workspace = await requireWorkspace();
      const source = await db.source.findFirst({
        where: { id: sourceId, workspaceId: workspace.id },
        include: {
          videos: { take: 5, orderBy: { postedAt: 'desc' }, select: { id: true, views: true, postedAt: true } },
          refreshRuns: { take: 3, orderBy: { ranAt: 'desc' } },
        },
      });
      if (!source) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify(source, null, 2) }] };
    });

  // ---- create_source ----
  server.tool('create_source',
    'Add a new tracked source (creator, keyword, or hashtag) to monitor.',
    {
      platform: z.enum(['tiktok', 'reels', 'shorts']).describe('Platform to track'),
      sourceType: z.enum(['creator', 'keyword', 'hashtag']).describe('Type of source'),
      query: z.string().describe('Handle, keyword phrase, or hashtag (with #)'),
      language: z.string().default('en').describe('Language code'),
      videoLimit: z.number().min(1).max(200).default(50).describe('Max videos per refresh'),
      refreshSchedule: z.enum(['manual', 'daily', 'weekly']).default('manual'),
      nicheTag: z.string().optional().describe('Niche/workspace tag'),
    },
    async ({ platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag }) => {
      const workspace = await requireWorkspace();

      const source = await db.source.create({
        data: {
          workspaceId: workspace.id,
          platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag,
        },
      });

      // A source with lastRefreshedAt: null holds nothing. Leaving the user
      // here is the single most common dead end in the product — the thing
      // they asked for looks done and produces no videos.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps(
          { message: 'Source created', source },
          [{
            label: `Pull videos for ${query} now`,
            tool: 'refresh_source',
            args: { sourceId: source.id },
            cost: `${apifyCostLabel(videoLimit)} + ${refreshCreditLabel(videoLimit)}`,
            spendsMoney: true,
            why: 'This source has no videos yet — it stays empty until refreshed. '
              + `Estimate assumes the full ${videoLimit}-video limit; a smaller scrape costs proportionally less.`,
          }],
        ), null, 2) }],
      };
    });

  // ---- update_source ----
  server.tool('update_source',
    'Update a tracked source. Pass only the fields you want to change.',
    {
      sourceId: z.string(),
      query: z.string().optional(),
      videoLimit: z.number().min(1).max(200).optional(),
      refreshSchedule: z.enum(['manual', 'daily', 'weekly']).optional(),
      isActive: z.boolean().optional(),
      nicheTag: z.string().nullable().optional(),
      language: z.string().optional(),
    },
    async ({ sourceId, ...updates }) => {
      const workspace = await requireWorkspace();
      const owned = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
      if (!owned) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      const source = await db.source.update({
        where: { id: sourceId },
        data: updates,
      }).catch(() => null);
      if (!source) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Source updated', source }, null, 2) }] };
    });

  // ---- delete_source ----
  server.tool('delete_source',
    'Delete a tracked source and all its videos, scores, and analyses.',
    { sourceId: z.string() },
    async ({ sourceId }) => {
      const workspace = await requireWorkspace();
      const owned = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
      if (!owned) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      // Delete in FK order
      await db.hook.deleteMany({ where: { video: { sourceId } } });
      await db.swipeEntry.deleteMany({ where: { video: { sourceId } } });
      await db.idea.deleteMany({ where: { video: { sourceId } } });
      await db.analysis.deleteMany({ where: { videoId: { in: (await db.video.findMany({ where: { sourceId }, select: { id: true } })).map(v => v.id) } } });
      await db.score.deleteMany({ where: { videoId: { in: (await db.video.findMany({ where: { sourceId }, select: { id: true } })).map(v => v.id) } } });
      await db.refreshRun.deleteMany({ where: { sourceId } });
      await db.video.deleteMany({ where: { sourceId } });
      await db.source.delete({ where: { id: sourceId } }).catch(() => null);

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Source deleted', sourceId }) }] };
    });

  // ---- refresh_source ----
  server.tool('refresh_source',
    'Trigger a manual refresh for a source. TikTok uses the clockworks/tiktok-scraper actor (live). Instagram Reels and YouTube Shorts are stubs for now. Costs 1.5 credits per video returned. All Apify calls are also subject to the platform-wide APIFY_SPEND_CAP_CENTS guardrail (default $5) — if exceeded, the call is refused and a cap_breach event is logged.',
    {
      sourceId: z.string(),
      videoLimit: z.number().min(1).max(200).optional().describe('Override source video limit for this run'),
      async: z.boolean().optional()
        .describe('Force inline (false) or queued (true). Default: queued — a scrape does not fit inside a tool call. Only pass false for debugging.'),
    },
    async ({ sourceId, videoLimit: limitOverride, async: asyncMode }) => {
      const workspace = await requireWorkspace();
      const source = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
      if (!source) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      const limit = limitOverride ?? source.videoLimit;

      // Queue anything big enough to risk the 60s request budget. A scrape that
      // outlives it is killed after the Apify spend but before the rescore —
      // the user pays and the scoring never updates. Small scrapes stay inline
      // because a synchronous answer is nicer when it genuinely fits.
      const shouldQueue = asyncMode ?? limit > INLINE_REFRESH_MAX_VIDEOS;
      if (shouldQueue) {
        const existing = await outstandingJobForSource(sourceId);
        if (existing) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'A refresh is already queued or running for this source — not enqueuing a second one.',
            jobId: existing.id, status: existing.status, sourceId,
            note: 'Wait on the existing job with await_job rather than paying for a duplicate scrape.',
          }, null, 2) }] };
        }

        const deadlineAt = new Date(Date.now() + REFRESH_JOB_DEADLINE_MS);
        const job = await enqueueRefreshJob({
          workspaceId: workspace.id,
          sourceId,
          payload: { limitOverride },
          deadlineAt,
        });
        // Best-effort poke; pg_cron drains within a minute regardless.
        const dispatch = await dispatchWorker('refresh');

        return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Refresh queued for ${source.query}. Credits are charged by the worker when it runs, not now.`,
          jobId: job.id,
          sourceId,
          query: source.query,
          videoLimit: limit,
          estimatedCost: `${apifyCostLabel(limit)} + ${refreshCreditLabel(limit)} (worst case — settled down to actual videos returned)`,
          deadlineAt: deadlineAt.toISOString(),
          workerDispatched: dispatch.dispatched,
          note: 'Queued rather than run inline because a scrape this size can outlive the request budget, '
            + 'which previously billed the user and then killed the rescore. Wait with await_job.',
        }, [{
          label: 'Wait for it to finish',
          tool: 'await_job',
          args: { jobId: job.id },
          why: 'Free. Blocks server-side ~25s per call and returns as soon as the job is done or failed. '
            + 'Keep calling only while shouldKeepPolling is true.',
        }]), null, 2) }] };
      }
      const startTime = Date.now();
      let itemsPulled = 0;
      let newVideos = 0;
      let costCents = 0;
      const errors: string[] = [];

      // Pre-flight: platform-wide Apify cap (unrelated to this workspace's
      // credit balance — a circuit breaker against a bug or runaway deploy).
      if (source.platform !== 'shorts') {
        const capStatus = await getApifyCapStatus(source.workspaceId);
        if (capStatus.breached) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'APIFY SPEND CAP ALREADY BREACHED',
              capStatus,
              message: 'Refresh refused. Raise APIFY_SPEND_CAP_CENTS in .env or wait until next month.',
            }, null, 2) }],
            isError: true,
          };
        }
      }

      // Pre-authorize credits for the worst case (full `limit` videos
      // returned). Refunded down to actual usage below.
      const opId = randomUUID();
      const preAuthCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * limit);
      let creditBalance;
      try {
        creditBalance = await debitCredits(workspace.id, preAuthCredits, 'refresh_source', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }
      let actualCredits = 0; // set as soon as we know how many videos Apify actually returned

      try {
        const result = await scrapeSource({
          workspaceId: source.workspaceId,
          platform: source.platform,
          sourceType: source.sourceType as 'creator' | 'keyword' | 'hashtag',
          query: source.query,
          limit,
        });

        itemsPulled = result.items.length;
        costCents = result.costCents;

        // The actor signals a bad query with an in-dataset record, not a failed
        // run (see collectNotices in src/lib/apify.ts). Without this, a source
        // whose handle or hashtag does not exist reports a successful refresh
        // with errors: [] every time, while still costing a full scrape.
        if (result.notices.length > 0) {
          errors.push(...result.notices);
        }
        // Set as soon as the Apify cost is actually incurred — if DB
        // persistence or scoring throws below, this still reflects the
        // real COGS already spent, so the refund settlement stays correct.
        actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * itemsPulled);

        // Persist videos (dedup by platform + externalId)
        const thumbTargets: ThumbIngestTarget[] = [];
        for (const nv of result.items) {
          const existing = await db.video.findFirst({
            where: { platform: nv.platform, externalId: nv.externalId },
            select: { id: true },
          });
          if (existing) continue;

          const created = await db.video.create({
            data: {
              sourceId,
              platform: nv.platform,
              externalId: nv.externalId,
              url: nv.url,
              thumbnailUrl: nv.thumbnailUrl,
              creatorHandle: nv.creatorHandle,
              creatorFollowers: nv.creatorFollowers,
              caption: nv.caption,
              postedAt: new Date(nv.postedAt),
              views: nv.views,
              likes: nv.likes,
              comments: nv.comments,
              shares: nv.shares,
              saves: nv.saves,
              durationSec: nv.durationSec,
              transcript: nv.transcript,
              transcriptSource: nv.transcriptSource,
              rawJson: JSON.stringify(nv.raw),
            },
            select: { id: true },
          });
          newVideos++;
          thumbTargets.push({
            videoId: created.id,
            platform: nv.platform,
            thumbnailUrl: nv.thumbnailUrl,
            coverDownloadUrl: nv.coverDownloadUrl,
          });
        }

        // Persist cover images to Supabase Storage. Deliberately after the
        // insert loop and batched (see src/lib/media.ts) — 50 sequential
        // round-trips would not fit the 60s function budget. Never throws:
        // a missing thumbnail must not fail a refresh that already paid Apify.
        if (thumbTargets.length > 0) {
          const ingest = await ingestThumbnails(source.workspaceId, thumbTargets);
          if (ingest.failed > 0) {
            errors.push(`Thumbnail ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
          }
        }

        // Re-score the source's videos so outliers surface
        if (newVideos > 0) {
          await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
        }
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          // Cap breach — refuse, refund the full pre-auth, and report.
          creditBalance = await refundCredits(workspace.id, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'SPEND CAP EXCEEDED',
              message: err.message,
              capStatus: await getApifyCapStatus(source.workspaceId),
              creditsCharged: 0,
              creditsRemaining: creditBalance.total,
            }, null, 2) }],
            isError: true,
          };
        }
        errors.push((err as Error).message);
      }

      // Settle: refund the unused portion of the pre-auth. actualCredits
      // stays 0 if scrapeSource itself threw before returning any items.
      const refundAmount = preAuthCredits - actualCredits;
      if (refundAmount > 0) {
        creditBalance = await refundCredits(workspace.id, refundAmount, 'refresh_source', `${opId}:settle`, 'usage_settlement');
      }

      // Log the refresh run regardless of outcome
      await db.refreshRun.create({
        data: { sourceId, itemsPulled, newVideos, errorsJson: JSON.stringify(errors), costCents, ranAt: new Date() },
      });
      await db.source.update({ where: { id: sourceId }, data: { lastRefreshedAt: new Date() } });

      // Refreshing a CREATOR source is the moment that creator's history can
      // cross CREATOR_BASELINE_MIN_SAMPLE — which changes the score of their
      // videos sitting in OTHER sources (the hashtag scrape that surfaced them).
      // Those rows are not touched by the batchScoreVideos call above, which is
      // scoped to this source, so without this they keep a stale `estimated`
      // score computed against a source median. See deepen_baselines.
      //
      // Queued, not run here. Doing it inline is what kept dying: measured on a
      // real run, the scrape and scoring finished 48.2s into a 60s budget,
      // leaving 11.3s to rescore a 30-video hashtag source. It was killed every
      // time, so the refresh was billed and the score never moved.
      //
      // This inline path is now debug-only (async: false), but it must not
      // reintroduce the bug it was written around.
      let rescoreQueued = false;
      if (source.sourceType === 'creator' && itemsPulled > 0) {
        try {
          await enqueueRescoreJob({
            workspaceId: workspace.id,
            sourceId,
            payload: { creatorHandle: source.query },
          });
          rescoreQueued = true;
        } catch (err) {
          errors.push(`could not queue rescore: ${(err as Error).message}`);
        }
      }

      // Surface standout outliers so the caller can OFFER to fetch their videos
      // (download + store the MP4 without a full analysis). Fixed at 50x: the
      // handful of winners per scrape, not the whole pool — that is what makes
      // fetching videos affordable. Counts only videos without stored media.
      const FETCH_SUGGEST_THRESHOLD = 50;
      const fetchCandidates = await db.video.count({
        where: {
          sourceId,
          mediaStatus: { not: 'stored' },
          score: { outlierScore: { gte: FETCH_SUGGEST_THRESHOLD } },
        },
      });
      const fetchSuggestion = fetchCandidates > 0
        ? {
            threshold: FETCH_SUGGEST_THRESHOLD,
            count: fetchCandidates,
            hint: `${fetchCandidates} video(s) scored >= ${FETCH_SUGGEST_THRESHOLD}x and have no stored video yet. Ask the user if they want to see them play, then call fetch_videos with minOutlierScore ${FETCH_SUGGEST_THRESHOLD} (est ~${fetchCandidates}c Apify).`,
          }
        : null;

      const capStatus = source.platform !== 'shorts'
        ? await getApifyCapStatus(source.workspaceId)
        : null;

      // Videos worth paying to analyse: creator-relative ("actual") scores
      // only. An "estimated" score compares a video to its source's median,
      // which mostly flags big accounts posting normally — poor value for
      // credits. Prefer the ones that beat their own creator's baseline.
      const analyzeCandidates = await db.video.findMany({
        where: {
          sourceId,
          analyses: { none: {} },
          score: { scoreType: 'actual', outlierScore: { gte: 5 } },
        },
        include: { score: true },
        orderBy: { score: { outlierScore: 'desc' } },
        take: 5,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: errors.length ? 'Refresh completed with errors' : 'Refresh successful',
          sourceId,
          platform: source.platform,
          sourceType: source.sourceType,
          query: source.query,
          itemsPulled,
          newVideos,
          costCents,
          costDisplay: `$${(costCents / 100).toFixed(4)}`,
          durationMs: Date.now() - startTime,
          errors: errors.length ? errors : undefined,
          apifyCapStatus: capStatus,
          creditsCharged: actualCredits,
          creditsRemaining: creditBalance.total,
          fetchSuggestion,
          // Present only when this refresh gave a creator enough history to be
          // scored against themselves, which restates their videos elsewhere.
          ...(rescoreQueued ? {
            rescoreQueued: true,
            rescoreNote: `@${source.query} may now have enough history for an 'actual' baseline, so a rescore of `
              + 'their videos in other sources has been QUEUED — it runs within a minute, or immediately via '
              + 'rescore_sources. Once it lands, check whether the outlier score held up or collapsed: that is '
              + 'the answer to whether it was a real breakout.',
          } : {}),
        }, [
          newVideos > 0 ? {
            label: `See what came back from ${source.query}`,
            tool: 'show_gallery',
            args: { sourceId },
            why: 'Free. Thumbnails and filters for just this scrape.',
          } : null,
          analyzeCandidates.length > 0 ? {
            label: `Analyze ${analyzeCandidates.length === 1 ? 'the standout' : `the ${analyzeCandidates.length} standouts`}`,
            tool: 'analyze_video',
            args: { videoId: analyzeCandidates[0]!.id },
            cost: analyzeCostLabel(analyzeCandidates.length),
            spendsMoney: true,
            why: `Beat their own creator's baseline: ${analyzeCandidates
              .map(c => `@${c.creatorHandle} ${c.score?.outlierScore.toFixed(0)}×`)
              .join(', ')}. One call per videoId; confirm the total before starting.`,
          } : null,
          newVideos === 0 && itemsPulled > 0 ? {
            label: 'Track something new instead',
            tool: 'create_source',
            why: `All ${itemsPulled} videos were already known — this source has gone stale. Free to track; refreshing it later is what costs.`,
          } : null,
        ]), null, 2) }],
      };
    });
}