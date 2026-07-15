// ---------------------------------------------------------------------------
// MCP Tools: Video Detail + AI Analysis
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { analyzeVideoWithDownload } from '../analysis/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerVideoTools(server: McpServer) {

  // ---- get_video ----
  server.tool('get_video',
    'Get full details of a video including stats, score, analysis, and available actions.',
    { videoId: z.string() },
    async ({ videoId }) => {
      const video = await db.video.findUnique({
        where: { id: videoId },
        include: {
          score: true,
          source: { select: { id: true, query: true, platform: true, nicheTag: true, workspaceId: true } },
          analyses: { include: { hooks: true } },
          hooks: true,
          ideas: true,
        },
      });
      if (!video) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Video not found' }) }], isError: true };

      const engRate = video.views > 0
        ? ((video.likes + video.comments + (video.shares ?? 0)) / video.views * 100).toFixed(1)
        : '0';

      const latestAnalysis = video.analyses[0]
        ? {
            id: video.analyses[0].id,
            analysisBasis: video.analyses[0].analysisBasis,
            backend: video.analyses[0].backend,
            model: video.analyses[0].model,
            costCents: video.analyses[0].costCents,
            analysis: JSON.parse(video.analyses[0].analysisJson),
            hookCount: video.analyses[0].hooks?.length ?? 0,
          }
        : null;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          id: video.id,
          platform: video.platform,
          externalId: video.externalId,
          url: video.url,
          thumbnailUrl: video.thumbnailUrl,
          creatorHandle: video.creatorHandle,
          creatorFollowers: video.creatorFollowers,
          caption: video.caption,
          postedAt: video.postedAt.toISOString(),
          stats: {
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
            saves: video.saves,
            durationSec: video.durationSec,
            engagementRate: `${engRate}%`,
          },
          transcript: video.transcript,
          transcriptSource: video.transcriptSource,
          score: video.score,
          source: video.source,
          analysis: latestAnalysis,
          hooks: video.hooks,
          ideaCount: video.ideas?.length ?? 0,
          scrapedAt: video.scrapedAt.toISOString(),
          actions: {
            canAnalyze: !video.analyses.length,
            canExtractHook: !!latestAnalysis && (latestAnalysis.analysisBasis.startsWith('video') || latestAnalysis.analysisBasis === 'transcript+thumbnail'),
            hasIdea: (video.ideas?.length ?? 0) > 0,
          },
        }, null, 2) }],
      };
    });

  // ---- analyze_video ----
  server.tool('analyze_video',
    'Run AI analysis on a video. Uses the configured backend (default: gemini-native, fallback: gemini-text). Auto-fallbacks on failure. gemini-native uploads the video file for native understanding (shots, audio, on-screen text); gemini-text does a text-only call on transcript + caption + metadata when video upload fails or yt-dlp is unavailable.',
    {
      videoId: z.string().describe('Video ID to analyze'),
      forceBackend: z.enum(['gemini-native', 'gemini-text']).optional().describe('Override the workspace default backend'),
    },
    async ({ videoId, forceBackend }) => {
      try {
        const result = await analyzeVideoWithDownload(videoId, { forceBackend });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'Analysis complete',
            id: result.id,
            analysisBasis: result.analysisBasis,
            confidence: result.confidence,
            backend: result.backend,
            model: result.model,
            costCents: result.costCents,
            analysis: result.analysis,
          }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Analysis failed',
            message: (err as Error).message,
          }) }],
          isError: true,
        };
      }
    });

  // ---- get_video_transcript ----
  server.tool('get_video_transcript',
    'Get the transcript for a video, if available.',
    { videoId: z.string() },
    async ({ videoId }) => {
      const video = await db.video.findUnique({
        where: { id: videoId },
        select: { id: true, transcript: true, transcriptSource: true, caption: true, url: true },
      });
      if (!video) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Video not found' }) }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          videoId: video.id,
          transcript: video.transcript,
          transcriptSource: video.transcriptSource,
          hasTranscript: !!video.transcript?.trim(),
          caption: video.caption,
          url: video.url,
          note: video.transcript ? 'Transcript available from source captions.' : 'No transcript available. Use VLM/ASR skill to transcribe the video audio.',
        }, null, 2) }],
      };
    });
}