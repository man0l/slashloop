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

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Source created', source }, null, 2) }],
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
    },
    async ({ sourceId, videoLimit: limitOverride }) => {
      const workspace = await requireWorkspace();
      const source = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
      if (!source) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Source not found' }) }], isError: true };

      const limit = limitOverride ?? source.videoLimit;
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
        // Set as soon as the Apify cost is actually incurred — if DB
        // persistence or scoring throws below, this still reflects the
        // real COGS already spent, so the refund settlement stays correct.
        actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * itemsPulled);

        // Persist videos (dedup by platform + externalId)
        for (const nv of result.items) {
          const existing = await db.video.findFirst({
            where: { platform: nv.platform, externalId: nv.externalId },
            select: { id: true },
          });
          if (existing) continue;

          await db.video.create({
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
          });
          newVideos++;
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

      const capStatus = source.platform !== 'shorts'
        ? await getApifyCapStatus(source.workspaceId)
        : null;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
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
        }, null, 2) }],
      };
    });
}