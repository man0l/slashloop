// ---------------------------------------------------------------------------
// MCP Tools: Source Management (CRUD + refresh)
//
// Thin wrappers over src/lib/sources-service.ts, which owns the actual data
// logic and is shared with the REST API (api/sources/*.ts). This file's job
// is just: resolve the caller's workspace, call the service, shape the
// conversational (withNextSteps) response.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';
import { insufficientCreditsPayload, CREDIT_COSTS } from '../lib/credits.js';
import { withNextSteps, apifyCostLabel, analyzeCostLabel, refreshCreditLabel } from '../lib/next-steps.js';
import {
  listSourcesForWorkspace,
  getSourceForWorkspace,
  createSourceForWorkspace,
  updateSourceForWorkspace,
  deleteSourceForWorkspace,
  refreshSourceForWorkspace,
} from '../lib/sources-service.js';
import { seedSourceCandidates, verifySourceCandidate, dismissSuggestion } from '../lib/suggestions.js';
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
      const sources = await listSourcesForWorkspace(workspace, { platform, sourceType, isActive, nicheTag });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sources, null, 2) }],
      };
    });

  // ---- get_source ----
  server.tool('get_source',
    'Get details of a single tracked source by ID.',
    { sourceId: z.string().describe('Source ID') },
    async ({ sourceId }) => {
      const workspace = await requireWorkspace();
      const source = await getSourceForWorkspace(workspace, sourceId);
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
      // 20, not 50. This default decides whether a new user ever reaches the
      // part of the product that has value.
      //
      // The free tier is 300 credits and a refresh costs 1.5 per video, so at
      // 50 a single source costs 75 credits. Tracking four sources — the
      // natural first session — spends the entire allowance before a single
      // analysis, and analysis is where the insight is. At 20 the same session
      // costs 120 and leaves room for 36 analyses.
      //
      // Little is lost: the scraper routinely overshoots the limit anyway (a
      // 20-video request returned 30 in practice), and hashtag refreshes mostly
      // return videos already held. Raising it per-source stays one call away.
      videoLimit: z.number().min(1).max(200).default(20)
        .describe('Max videos per refresh (default 20 ≈ 30 credits). Costs 1.5 credits per video returned, '
          + 'so raise it deliberately — 50 videos is 75 credits.'),
      refreshSchedule: z.enum(['manual', 'daily', 'weekly']).default('manual'),
      nicheTag: z.string().optional().describe('Niche/workspace tag'),
    },
    async ({ platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag }) => {
      const workspace = await requireWorkspace();
      const result = await createSourceForWorkspace(workspace, {
        platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag,
      });

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: result.error,
            platform: result.platform,
            message: result.message,
            suggestion: result.suggestion,
          }, null, 2) }],
          isError: true,
        };
      }

      // A source with lastRefreshedAt: null holds nothing. Leaving the user
      // here is the single most common dead end in the product — the thing
      // they asked for looks done and produces no videos.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps(
          { message: 'Source created', source: result.source },
          [{
            label: `Pull videos for ${query} now`,
            tool: 'refresh_source',
            args: { sourceId: result.source.id },
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
      const source = await updateSourceForWorkspace(workspace, sourceId, updates);
      if (!source) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Source updated', source }, null, 2) }] };
    });

  // ---- delete_source ----
  server.tool('delete_source',
    'Delete a tracked source and all its videos, scores, and analyses.',
    { sourceId: z.string() },
    async ({ sourceId }) => {
      const workspace = await requireWorkspace();
      const deleted = await deleteSourceForWorkspace(workspace, sourceId);
      if (!deleted) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

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
    async ({ sourceId, videoLimit, async: asyncMode }) => {
      const workspace = await requireWorkspace();
      const result = await refreshSourceForWorkspace(workspace, sourceId, { videoLimit, async: asyncMode });

      switch (result.kind) {
        case 'not_found':
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

        case 'already_queued':
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'A refresh is already queued or running for this source — not enqueuing a second one.',
            jobId: result.jobId, status: result.status, sourceId: result.sourceId,
            note: 'Wait on the existing job with await_job rather than paying for a duplicate scrape.',
          }, null, 2) }] };

        case 'queued':
          return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
            message: `Refresh queued for ${result.query}. Credits are charged by the worker when it runs, not now.`,
            jobId: result.jobId,
            sourceId: result.sourceId,
            query: result.query,
            videoLimit: result.videoLimit,
            estimatedCost: `${apifyCostLabel(result.videoLimit)} + ${refreshCreditLabel(result.videoLimit)} (worst case — settled down to actual videos returned)`,
            deadlineAt: result.deadlineAt,
            workerDispatched: result.workerDispatched,
            note: 'Queued rather than run inline because a scrape this size can outlive the request budget, '
              + 'which previously billed the user and then killed the rescore. Wait with await_job.',
          }, [{
            label: 'Wait for it to finish',
            tool: 'await_job',
            args: { jobId: result.jobId },
            why: 'Free. Blocks server-side ~25s per call and returns as soon as the job is done or failed. '
              + 'Keep calling only while shouldKeepPolling is true.',
          }]), null, 2) }] };

        case 'cap_breached':
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'APIFY SPEND CAP ALREADY BREACHED',
              capStatus: result.capStatus,
              message: 'Refresh refused. Raise APIFY_SPEND_CAP_CENTS in .env or wait until next month.',
            }, null, 2) }],
            isError: true,
          };

        case 'insufficient_credits':
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(result.err), null, 2) }], isError: true };

        case 'spend_cap_exceeded':
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'SPEND CAP EXCEEDED',
              message: result.message,
              capStatus: result.capStatus,
              creditsCharged: 0,
              creditsRemaining: result.creditsRemaining,
            }, null, 2) }],
            isError: true,
          };

        case 'done':
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
              message: result.message,
              sourceId: result.sourceId,
              platform: result.platform,
              sourceType: result.sourceType,
              query: result.query,
              itemsPulled: result.itemsPulled,
              newVideos: result.newVideos,
              costCents: result.costCents,
              costDisplay: `$${(result.costCents / 100).toFixed(4)}`,
              durationMs: result.durationMs,
              errors: result.errors.length ? result.errors : undefined,
              apifyCapStatus: result.apifyCapStatus,
              creditsCharged: result.creditsCharged,
              creditsRemaining: result.creditsRemaining,
              fetchSuggestion: result.fetchSuggestion,
              // Present only when this refresh gave a creator enough history to be
              // scored against themselves, which restates their videos elsewhere.
              ...(result.rescoreQueued ? {
                rescoreQueued: true,
                rescoreNote: `@${result.query} may now have enough history for an 'actual' baseline, so a rescore of `
                  + 'their videos in other sources has been QUEUED — it runs within a minute, or immediately via '
                  + 'rescore_sources. Once it lands, check whether the outlier score held up or collapsed: that is '
                  + 'the answer to whether it was a real breakout.',
              } : {}),
            }, [
              result.newVideos > 0 ? {
                label: `See what came back from ${result.query}`,
                tool: 'show_gallery',
                args: { sourceId: result.sourceId },
                why: 'Free. Thumbnails and filters for just this scrape.',
              } : null,
              result.analyzeCandidates.length > 0 ? {
                label: `Analyze ${result.analyzeCandidates.length === 1 ? 'the standout' : `the ${result.analyzeCandidates.length} standouts`}`,
                tool: 'analyze_video',
                args: { videoId: result.analyzeCandidates[0]!.id },
                cost: analyzeCostLabel(result.analyzeCandidates.length),
                spendsMoney: true,
                why: `Beat their own creator's baseline: ${result.analyzeCandidates
                  .map(c => `@${c.creatorHandle} ${c.outlierScore?.toFixed(0)}×`)
                  .join(', ')}. One call per videoId; confirm the total before starting.`,
              } : null,
              result.newVideos === 0 && result.itemsPulled > 0 ? {
                label: 'Track something new instead',
                tool: 'create_source',
                why: `All ${result.itemsPulled} videos were already known — this source has gone stale. Free to track; refreshing it later is what costs.`,
              } : null,
            ]), null, 2) }],
          };
      }
    });

  // ---- suggest_sources ----
  server.tool('suggest_sources',
    `AI-suggested new hashtags, keywords, or creators to track, seeded from this workspace's biggest outliers. `
    + `Costs ${CREDIT_COSTS.suggestSources} credits for the AI call, plus a small verification scrape per candidate `
    + `(~5 videos at ${CREDIT_COSTS.refreshSourcePerVideo} credits/video) — a candidate is only ever shown if that scrape `
    + `actually found real videos, so no hallucinated hashtag/handle gets suggested. Needs at least one scored outlier to `
    + `seed from — refresh a source first if this is a brand new workspace.`,
    {},
    async () => {
      const workspace = await requireWorkspace();
      const seed = await seedSourceCandidates(workspace);

      if (!seed.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'suggest_sources_failed',
            message: seed.errors[0] ?? 'Could not generate suggestions.',
            creditsCharged: seed.creditsCharged,
            creditsRemaining: seed.creditsRemaining,
          }, null, 2) }],
          isError: true,
        };
      }

      // A conversational tool call has to return one final answer, so
      // (unlike the site UI, which shows each candidate as its own check
      // resolves) verify every candidate here before responding — each is
      // still its own independent Apify scrape, just run concurrently.
      const verifications = await Promise.all(seed.candidates.map(c => verifySourceCandidate(workspace, c)));

      const suggestions = verifications.filter(v => v.verified).map(v => v.suggestion!);
      const notices = verifications.filter(v => v.error).map(v => v.error!);
      const creditsCharged = seed.creditsCharged + verifications.reduce((sum, v) => sum + v.creditsCharged, 0);
      const creditsRemaining = verifications.length > 0
        ? verifications[verifications.length - 1].creditsRemaining
        : seed.creditsRemaining;
      const discardedCount = seed.alreadyTrackedCount + seed.alreadyDismissedCount + verifications.filter(v => !v.verified).length;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: suggestions.length > 0
            ? `${suggestions.length} verified suggestion(s) — each one actually returned real videos when checked.`
            : `${seed.rawCandidateCount} candidate(s) proposed, none survived verification (already tracked or no real content found).`,
          suggestions,
          rawCandidateCount: seed.rawCandidateCount,
          discardedCount,
          creditsCharged,
          creditsRemaining,
          notices: notices.length ? notices : undefined,
        }, suggestions.map(s => ({
          label: `Track ${s.sourceType === 'hashtag' ? '#' : s.sourceType === 'creator' ? '@' : ''}${s.query}`,
          tool: 'create_source',
          args: { platform: 'tiktok', sourceType: s.sourceType, query: s.query },
          why: s.rationale,
        }))), null, 2) }],
      };
    });

  // ---- dismiss_suggested_source ----
  server.tool('dismiss_suggested_source',
    `Marks an AI-suggested hashtag/keyword/creator (from suggest_sources) as "no thanks" — future suggest_sources `
    + `calls for this workspace won't propose it again.`,
    {
      sourceType: z.enum(['hashtag', 'keyword', 'creator']),
      query: z.string().min(1).describe('The suggested query exactly as returned by suggest_sources, no # or @ prefix.'),
    },
    async ({ sourceType, query }) => {
      const workspace = await requireWorkspace();
      await dismissSuggestion(workspace, { sourceType, query });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Won't suggest ${sourceType === 'hashtag' ? '#' : sourceType === 'creator' ? '@' : ''}${query} again.`,
        }, []), null, 2) }],
      };
    });
}
