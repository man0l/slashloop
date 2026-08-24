// ---------------------------------------------------------------------------
// MCP Tool: fetch_videos — selectively download + store MP4s so videos play in
// the gallery, WITHOUT a full Gemini analysis.
//
// Two modes:
//   1. Threshold: fetch every outlier above a score (e.g. minOutlierScore=50).
//      This is the cheap, high-signal default — pull the few winners out of a
//      200-video scrape instead of all 200.
//   2. Manual: pass explicit videoIds for hand-picked videos.
//
// Fetch is a video download + Storage write, so it is governed by the
// download path's cap — the proxy traffic cap when the own worker handles
// downloads (the usual case; TikTok's CDN 403s datacenter IPs), else the
// Apify spend cap. NOT AI credits. It runs off the request path via the
// MediaJob queue (kind 'fetch'), drained by the same worker + pg_cron
// schedule as analyze jobs.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { enqueueFetchJob, outstandingJobForVideo, dispatchWorker } from '../lib/jobs.js';
import { costBlock } from '../lib/next-steps.js';
import { selectDownloadAdapter } from '../lib/scrapers/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Mirrors ESTIMATED_DOWNLOAD_COST_CENTS in lib/apify.ts (free-tier ceiling). */
const FETCH_COST_PER_VIDEO_CENTS = 1;
/** Cap on videos a single threshold fetch will queue, so one call can't dump
 *  the whole workspace onto the queue at once. */
const DEFAULT_FETCH_LIMIT = 20;

export function registerFetchTool(server: McpServer) {
  server.tool(
    'fetch_videos',
    'Download and store the MP4 for selected videos so they play inline in the gallery (with key-moment seeking), '
      + 'WITHOUT running Gemini analysis. Two modes: (1) minOutlierScore — fetch every video at or above an outlier '
      + 'score that has no stored video yet (e.g. 50 for the standout winners); (2) videoIds — hand-picked videos. '
      + 'Fetch is scraper spend (the residential-proxy worker when configured, else Apify ≈1¢/video), subject to the '
      + 'matching spend cap — not AI credits. Runs in the background; poll get_video until mediaStatus = stored. '
      + 'Use after refresh_source, when the user wants to SEE/scrub specific outliers rather than only thumbnails.',
    {
      minOutlierScore: z
        .number()
        .min(1)
        .optional()
        .describe('Fetch all videos with outlier score >= this that have no stored video (e.g. 50).'),
      videoIds: z
        .array(z.string())
        .optional()
        .describe('Specific video ids to fetch (manual selection).'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe(`Cap on videos queued by minOutlierScore (default ${DEFAULT_FETCH_LIMIT}).`),
    },
    async ({ minOutlierScore, videoIds, limit }) => {
      const workspace = await requireWorkspace();
      const cap = limit ?? DEFAULT_FETCH_LIMIT;

      // Resolve target ids by mode.
      let pool: { id: string; creatorHandle: string; outlierScore: number | null }[] = [];
      if (videoIds && videoIds.length) {
        const vids = await db.video.findMany({
          where: { id: { in: videoIds }, source: { workspaceId: workspace.id } },
          include: { score: true },
        });
        pool = vids.map((v) => ({ id: v.id, creatorHandle: v.creatorHandle, outlierScore: v.score?.outlierScore ?? null }));
      } else if (minOutlierScore != null) {
        const vids = await db.video.findMany({
          where: { source: { workspaceId: workspace.id }, score: { outlierScore: { gte: minOutlierScore } } },
          include: { score: true },
          orderBy: { score: { outlierScore: 'desc' } },
          take: 200,
        });
        pool = vids.map((v) => ({ id: v.id, creatorHandle: v.creatorHandle, outlierScore: v.score?.outlierScore ?? null }));
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Provide either minOutlierScore or videoIds.' }),
          }],
          isError: true,
        };
      }

      // Filter out videos already stored or with an outstanding job.
      const eligible: typeof pool = [];
      let skippedStored = 0;
      let skippedQueued = 0;
      for (const t of pool) {
        if (eligible.length >= cap) break;
        const v = await db.video.findUnique({ where: { id: t.id }, select: { mediaStatus: true, platform: true, url: true } });
        if (!v || v.platform !== 'tiktok' || !v.url) continue;
        if (v.mediaStatus === 'stored') { skippedStored++; continue; }
        if (await outstandingJobForVideo(t.id)) { skippedQueued++; continue; }
        eligible.push(t);
      }

      for (const t of eligible) {
        await enqueueFetchJob({ workspaceId: workspace.id, videoId: t.id });
      }
      if (eligible.length) await dispatchWorker();

      // Which ledger this spend actually lands in. Downloads prefer the own
      // proxy worker (TikTok's CDN 403s datacenter IPs); Apify is the
      // fallback when no SCRAPER_PROXY_URL is configured.
      let viaProxy = false;
      try { viaProxy = selectDownloadAdapter('tiktok').name !== 'apify'; } catch { /* unconfigured — quote the Apify ceiling */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: eligible.length
              ? `Queued ${eligible.length} video(s) for download. They will be playable in the gallery once stored.`
              : 'Nothing to fetch — all target videos are already stored, already queued, or not downloadable.',
            queued: eligible.length,
            threshold: minOutlierScore ?? null,
            estimatedScraperCostCents: eligible.length * FETCH_COST_PER_VIDEO_CENTS,
            cost: costBlock(0, {
              scraperCents: eligible.length * FETCH_COST_PER_VIDEO_CENTS,
              quoted: true,
              note: viaProxy
                ? 'Proxy traffic on the own worker (PROXY_TRAFFIC_CAP_GB), not AI credits. Per-video figure is the pre-auth ceiling.'
                : 'Apify spend (APIFY_SPEND_CAP_CENTS), not AI credits.',
            }),
            skippedAlreadyStored: skippedStored,
            skippedHasOutstandingJob: skippedQueued,
            videos: eligible,
            note: 'Downloads run in the background (pg_cron drains the queue ~every minute). Poll get_video — mediaStatus goes none → stored.',
          }, null, 2),
        }],
      };
    },
  );
}
