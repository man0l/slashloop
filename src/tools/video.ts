// ---------------------------------------------------------------------------
// MCP Tools: Video Detail + AI Analysis
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { analyzeVideoForWorkspace } from '../lib/video-service.js';
import { resolveThumbUrl, signedMediaUrl, frameUrlAt } from '../lib/media.js';
import { outstandingJobForVideo } from '../lib/jobs.js';
import { withNextSteps } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerVideoTools(server: McpServer) {

  // ---- get_video ----
  server.tool('get_video',
    'Get full details of a video including stats, score, analysis, and available actions.',
    { videoId: z.string() },
    async ({ videoId }) => {
      const workspace = await requireWorkspace();
      // Scoped to the caller's own workspace — a video id is a UUID (not
      // practically guessable), but nothing should ever return another
      // workspace's video regardless.
      const video = await db.video.findFirst({
        where: { id: videoId, source: { workspaceId: workspace.id } },
        include: {
          score: true,
          source: { select: { id: true, query: true, platform: true, nicheTag: true, workspaceId: true } },
          // Newest first. Without an explicit order Prisma returns whatever the
          // database yields, which in practice was insertion order — so
          // `analyses[0]`, named latestAnalysis and used for both the analysis
          // payload and the recreation block, was actually the OLDEST row. A
          // re-analysed video kept reporting its first result forever, and the
          // recreation block read key moments from an analysis that predated
          // the field and so was always null.
          analyses: { include: { hooks: true }, orderBy: { createdAt: 'desc' } },
          hooks: true,
          ideas: true,
        },
      });
      if (!video) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Video not found' }) }], isError: true };

      const engRate = video.views > 0
        ? ((video.likes + video.comments + (video.shares ?? 0)) / video.views * 100).toFixed(1)
        : '0';

      // A queued or running analysis, so a caller that got a jobId from
      // analyze_video can poll here instead of being told "no analysis yet"
      // with no indication that one is on its way.
      const job = await outstandingJobForVideo(video.id);
      const analysisJob = job
        ? {
            jobId: job.id,
            status: job.status,
            attempts: job.attempts,
            queuedAt: job.createdAt.toISOString(),
            startedAt: job.startedAt?.toISOString() ?? null,
            lastError: job.lastError,
          }
        : null;

      // Recreation view: the key moments, each seekable straight into the
      // stored MP4. One signature, one fragment per moment (see signedMediaUrl).
      // Emitted separately from `analysis` because this is the "go shoot this"
      // surface, not the "why did it work" one.
      let recreation: unknown = null;
      if (video.analyses[0]) {
        const parsed = JSON.parse(video.analyses[0].analysisJson) as { keyMoments?: unknown };
        const moments = Array.isArray(parsed.keyMoments) ? parsed.keyMoments : null;
        if (moments?.length) {
          const media = await signedMediaUrl(video);
          recreation = {
            keyMoments: moments.map((m) => {
              const ts = typeof (m as { timestampSec?: unknown }).timestampSec === 'number'
                ? (m as { timestampSec: number }).timestampSec
                : 0;
              return { ...(m as object), frameUrl: media.url ? frameUrlAt(media.url, ts) : null };
            }),
            // Say why a frame is missing rather than emitting a silent null —
            // 'media_expired' means retention swept it, which is recoverable by
            // re-analysing, and that is worth distinguishing from a hard failure.
            frameUrlsUnavailable: media.url ? undefined : media.reason,
          };
        }
      }

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
          thumbUrl: resolveThumbUrl(video),
          thumbStatus: video.thumbStatus,
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
          recreation,
          analysisJob,
          hooks: video.hooks,
          ideaCount: video.ideas?.length ?? 0,
          scrapedAt: video.scrapedAt.toISOString(),
          actions: {
            canAnalyze: true,
            hasAnalysis: video.analyses.length > 0,
            canExtractHook: !!latestAnalysis && (latestAnalysis.analysisBasis.startsWith('video') || latestAnalysis.analysisBasis === 'transcript+thumbnail'),
            hasIdea: (video.ideas?.length ?? 0) > 0,
          },
        }, null, 2) }],
      };
    });

  // ---- analyze_video ----
  server.tool('analyze_video',
    'Run AI analysis on a video. Uses the configured backend (default: gemini-native, fallback: gemini-text). gemini-native downloads the video via Apify then uploads it for native understanding (shots, audio, on-screen text); gemini-text does a text-only call on transcript + caption + metadata. Costs 5 credits. gemini-native is QUEUED rather than run inline — it cannot finish inside one request — so the response is a jobId and status, not an analysis. Wait for it with await_job (blocks server-side and returns the moment it finishes) rather than polling get_video in a loop; the analysisJob field on get_video still reports progress for a one-off check. gemini-text returns its analysis directly.',
    {
      videoId: z.string().describe('Video ID to analyze'),
      forceBackend: z.enum(['gemini-native', 'gemini-text', 'openrouter-video']).optional().describe('Override the workspace default backend'),
    },
    async ({ videoId, forceBackend }) => {
      const workspace = await requireWorkspace();
      const outcome = await analyzeVideoForWorkspace(workspace, videoId, { forceBackend });

      if (!outcome.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Analysis failed',
            message: outcome.error,
            creditsCharged: outcome.creditsCharged,
            creditsRemaining: outcome.creditsRemaining,
          }, null, 2) }],
          isError: true,
        };
      }

      // gemini-native cannot finish inside this request: Apify download, Gemini
      // upload, processing wait and generate together exceed the 60s function
      // ceiling (vercel.json), which the current Vercel plan cannot raise — and
      // the MCP client imposes its own timeout regardless. Every gemini-native
      // analysis to date has either died mid-flight or silently degraded to
      // text-only. So it goes to the queue and the caller gets a job id.
      //
      // gemini-text stays inline. It is a single text call that completes in
      // seconds, and routing it through the queue would make the one path that
      // currently works slower and require polling for no reason.
      if (outcome.queued) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
            message: 'Analysis queued',
            jobId: outcome.job.id,
            videoId,
            status: outcome.job.status,
            backend: outcome.backend,
            // Surfaced because it changes what to expect: a dropped dispatch
            // still runs, just on the next sweep instead of within seconds.
            dispatched: outcome.dispatched,
            dispatchNote: outcome.dispatched
              ? 'Worker invoked. Wait with await_job rather than polling get_video in a loop.'
              : `Worker not reached (${outcome.dispatchReason}); the job stays queued and the sweeper will run it.`,
            creditsCharged: outcome.creditsCharged,
            creditsRemaining: outcome.creditsRemaining,
          }, [{
            label: 'Wait for the analysis',
            tool: 'await_job',
            args: { jobId: outcome.job.id },
            why: 'Free. Blocks server-side ~25s per call and returns the moment the job is done or failed. '
              + 'Keep calling only while shouldKeepPolling is true. This replaces polling get_video in a loop, '
              + 'which burns a round-trip per check and has no stop condition.',
          }]), null, 2) }],
        };
      }

      const { result } = outcome;
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
          creditsCharged: outcome.creditsCharged,
          creditsRemaining: outcome.creditsRemaining,
        }, null, 2) }],
      };
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