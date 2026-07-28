// ---------------------------------------------------------------------------
// Analysis Module — Public API
//
// One interface, three backends, same Zod schema out.
// Switching is a config flag on the workspace.
// Fallback is automatic and logged.
// Every analysis records backend + model + cost_cents.
// Failure counts are persisted on Workspace.failureCountsJson so the fallback
// state survives server restarts (this matters for MCP servers spawned by
// Claude Code / OpenCode — each tool invocation may be a fresh process).
// ---------------------------------------------------------------------------

export { VideoAnalysisDataSchema, BriefDataSchema } from './schema.js';
export type { VideoAnalysisData, BriefData, Shot, OnScreenTextEntry, AudioAnalysis, EmotionalArcPoint } from './schema.js';
export type { AnalysisContext, AnalysisResult, BriefResult, AnalysisConfig, VideoAnalyzer } from './types.js';
export { DEFAULT_CONFIG, COST_ESTIMATES, BATCH_COST_ESTIMATES, getCostCents, basisToConfidence } from './types.js';
export { loadAnalysisConfig, updateAnalysisConfig } from './config.js';
export { generateBrief } from './briefs.js';
export { generateHookVariations, type HookVariation } from './hooks.js';

import { db } from '../db.js';
import { VideoAnalysisDataSchema } from './schema.js';
import { GeminiNativeAnalyzer } from './gemini-native.js';
import { GeminiTextAnalyzer } from './gemini-text.js';
import { loadAnalysisConfig, updateAnalysisConfig } from './config.js';
import { basisToConfidence, getCostCents, type AnalysisConfig, type AnalysisContext, type AnalysisResult, type VideoAnalyzer, DEFAULT_CONFIG } from './types.js';

// ---------------------------------------------------------------------------
// Factory — create the right backend from config
// ---------------------------------------------------------------------------

function createBackend(id: string, config: AnalysisConfig): VideoAnalyzer {
  switch (id) {
    case 'gemini-native': return new GeminiNativeAnalyzer(config);
    case 'gemini-text': return new GeminiTextAnalyzer(config);
    default: throw new Error(`Unknown analysis backend: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Consecutive failure tracking (DB-backed, per workspace)
//
// MCP servers spawned by Claude Code / OpenCode are short-lived processes.
// An in-memory Map would reset on every tool call. We persist counts in
// Workspace.failureCountsJson as { "<backendId>": <count> }.
// ---------------------------------------------------------------------------

const MAX_FAILURES_BEFORE_FALLBACK = 2;
const FAILURE_TTL_MS = 1000 * 60 * 60; // a "consecutive" failure window — older counts decay

type FailureMap = Record<string, { count: number; lastAt: number }>;

async function loadFailureMap(workspaceId: string): Promise<FailureMap> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { failureCountsJson: true } });
  if (!ws?.failureCountsJson) return {};
  try {
    const parsed = JSON.parse(ws.failureCountsJson);
    // Decay: drop entries older than FAILURE_TTL_MS so a transient outage
    // 1h ago doesn't keep us in fallback mode forever.
    const cutoff = Date.now() - FAILURE_TTL_MS;
    const out: FailureMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const entry = v as { count: number; lastAt: number };
      if (entry.lastAt >= cutoff) out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveFailureMap(workspaceId: string, map: FailureMap): Promise<void> {
  await db.workspace.update({
    where: { id: workspaceId },
    data: { failureCountsJson: JSON.stringify(map) },
  }).catch(err => console.error('[analysis] Failed to persist failure map:', err));
}

async function recordFailure(workspaceId: string, backendId: string): Promise<number> {
  const map = await loadFailureMap(workspaceId);
  const cur = map[backendId]?.count ?? 0;
  const newCount = cur + 1;
  map[backendId] = { count: newCount, lastAt: Date.now() };
  await saveFailureMap(workspaceId, map);
  return newCount;
}

async function recordSuccess(workspaceId: string, backendId: string): Promise<void> {
  const map = await loadFailureMap(workspaceId);
  if (map[backendId]?.count) {
    delete map[backendId];
    await saveFailureMap(workspaceId, map);
  }
}

async function getFailureCount(workspaceId: string, backendId: string): Promise<number> {
  const map = await loadFailureMap(workspaceId);
  return map[backendId]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// analyzeVideo — main entry point
//
// `options.batch` is true when invoked from run_auto_analyze. Backends use it
// to look up batch pricing (50% Gemini discount via Batch API).
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  forceBackend?: string;
  videoFilePath?: string;
  batch?: boolean;
}

export async function analyzeVideo(
  videoId: string,
  options?: AnalyzeOptions,
): Promise<AnalysisResult> {
  // 1. Fetch video with score and source
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: {
      score: true,
      source: { select: { workspaceId: true } },
    },
  });
  if (!video) throw new Error(`Video not found: ${videoId}`);

  // 2. Load config
  const workspaceId = video.source?.workspaceId ?? 'unknown';
  const config = workspaceId !== 'unknown' ? await loadAnalysisConfig(workspaceId) : { ...DEFAULT_CONFIG };
  const batch = options?.batch ?? false;

  // 3. Build analysis context
  const ctx: AnalysisContext = {
    videoId: video.id,
    videoUrl: video.url,
    thumbnailUrl: video.thumbnailUrl,
    caption: video.caption,
    transcript: video.transcript,
    transcriptSource: video.transcriptSource,
    platform: video.platform,
    creatorHandle: video.creatorHandle,
    creatorFollowers: video.creatorFollowers,
    postedAt: video.postedAt.toISOString(),
    views: video.views,
    likes: video.likes,
    comments: video.comments,
    shares: video.shares,
    saves: video.saves,
    durationSec: video.durationSec,
    outlierScore: video.score?.outlierScore ?? null,
    outlierExplanation: video.score?.explanation ?? null,
    workspaceId,
    videoFilePath: options?.videoFilePath,
    batch,
  };

  // 4. Determine backend chain (DB-backed failure check)
  const primaryFailureCount = await getFailureCount(workspaceId, config.backend);
  let primaryBackend = options?.forceBackend ?? config.backend;
  const fallbackBackend = config.fallback;

  if (primaryFailureCount >= MAX_FAILURES_BEFORE_FALLBACK && primaryBackend !== fallbackBackend) {
    console.warn(`[analysis] ${primaryBackend} has ${primaryFailureCount} consecutive failures (persisted), using fallback: ${fallbackBackend}`);
    primaryBackend = fallbackBackend;
  }

  // 5. Try primary, then fallback
  const backendsToTry = [primaryBackend];
  if (fallbackBackend && fallbackBackend !== primaryBackend) {
    backendsToTry.push(fallbackBackend);
  }

  let lastError: Error | null = null;

  for (const backendId of backendsToTry) {
    // gemini-native requires a video file; if none was provided (yt-dlp failed
    // or wasn't run), skip to gemini-text which works without one.
    if (backendId === 'gemini-native' && !ctx.videoFilePath) {
      console.log(`[analysis] ${backendId} requires video file, skipping to text-only fallback`);
      continue;
    }

    const backend = createBackend(backendId, config);
    const isFallback = backendId !== (options?.forceBackend ?? config.backend);

    try {
      console.log(`[analysis] Running ${backend.name} on video ${videoId}${isFallback ? ' (FALLBACK)' : ''}${batch ? ' (BATCH)' : ''}...`);
      const output = await backend.analyze(ctx);

      // Validate (should already be validated inside the backend, but double-check)
      const validated = VideoAnalysisDataSchema.safeParse(output.data);
      if (!validated.success) {
        throw new Error(`Output failed final validation: ${validated.error?.issues.map(i => i.message).join(', ')}`);
      }

      // Recompute cost using the batch table if requested
      const costCents = batch
        ? getCostCents(backendId as 'gemini-native' | 'gemini-text', output.model, true)
        : output.costCents;

      if (workspaceId !== 'unknown') {
        await recordSuccess(workspaceId, backendId);
      }

      // 6. Store in DB
      const saved = await db.analysis.create({
        data: {
          videoId,
          schemaVersion: 'v2',
          analysisJson: JSON.stringify(output.data),
          analysisBasis: output.analysisBasis,
          backend: output.backend + (isFallback ? ' (fallback)' : '') + (batch ? ' (batch)' : ''),
          model: output.model,
          costCents: Math.round(costCents * 100) / 100,
        },
      });

      // 7. Log usage
      if (workspaceId !== 'unknown') {
        const providerLabel = output.provider + (batch ? ' (batch)' : '');

        await db.usageLog.create({
          data: {
            workspaceId,
            kind: 'ai',
            provider: providerLabel,
            units: 1,
            costCents,
            refId: saved.id,
          },
        }).catch(err => console.error('[analysis] Failed to log usage:', err));
      }

      return {
        id: saved.id,
        analysis: validated.data,
        analysisBasis: output.analysisBasis,
        confidence: basisToConfidence(output.analysisBasis),
        backend: output.backend + (isFallback ? ' (fallback)' : '') + (batch ? ' (batch)' : ''),
        model: output.model,
        costCents,
      };

    } catch (err) {
      lastError = err as Error;
      if (workspaceId !== 'unknown') {
        const newCount = await recordFailure(workspaceId, backendId);
        console.error(`[analysis] ${backend.name} failed for video ${videoId}: ${(err as Error).message} (failure count for ${backendId}: ${newCount})`);
      } else {
        console.error(`[analysis] ${backend.name} failed for video ${videoId}:`, (err as Error).message);
      }

      if (isFallback) {
        // We're already on the fallback and it failed — give up
        break;
      }
      // Try next backend in chain
      continue;
    }
  }

  throw new Error(
    `All analysis backends failed for video ${videoId}. ` +
    `Last error: ${lastError?.message}. ` +
    `Backends tried: [${backendsToTry.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Convenience: analyze with auto video download
// ---------------------------------------------------------------------------

export async function analyzeVideoWithDownload(
  videoId: string,
  options?: { forceBackend?: string; batch?: boolean },
): Promise<AnalysisResult> {
  // Check if video file is needed
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: { source: { select: { workspaceId: true } } },
  });
  if (!video) throw new Error(`Video not found: ${videoId}`);

  const workspaceId = video.source?.workspaceId;
  const config = workspaceId ? await loadAnalysisConfig(workspaceId) : { ...DEFAULT_CONFIG };
  const backend = options?.forceBackend ?? config.backend;

  // If the backend needs a video file, download it via Apify.
  //
  // TikTok only: downloadTikTokVideo drives the clockworks/tiktok-scraper
  // actor, so a reels/shorts URL would pre-authorize spend against the cap
  // and then fail inside the actor. Those platforms have no scraper yet
  // (scrapeSource throws for both), but create_source still accepts them —
  // so the guard is on platform, not on whether a row can exist.
  let videoFilePath: string | undefined;
  if (backend === 'gemini-native' && video.platform === 'tiktok' && video.url && workspaceId) {
    try {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { downloadTikTokVideo } = await import('../lib/apify.js');

      const tmpDir = mkdtempSync(join(tmpdir(), 'slashloop-'));
      videoFilePath = join(tmpDir, `video_${videoId.slice(0, 8)}.mp4`);

      console.log(`[analysis] Downloading video via Apify: ${video.url}...`);
      const dl = await downloadTikTokVideo({
        workspaceId,
        videoUrl: video.url,
        outputPath: videoFilePath,
      });

      // Sanity-check the file landed and has real content
      const { statSync } = await import('node:fs');
      const stat = statSync(videoFilePath);
      if (stat.size < 1024) throw new Error('Downloaded file too small');

      console.log(`[analysis] Downloaded ${(stat.size / 1024 / 1024).toFixed(2)}MB (Apify cost: ${dl.costCents}c)`);
    } catch (err) {
      console.warn(`[analysis] Video download failed, falling back to text-only: ${(err as Error).message}`);
      videoFilePath = undefined;
    }
  }

  try {
    return await analyzeVideo(videoId, { ...options, videoFilePath });
  } finally {
    // Cleanup temp file
    if (videoFilePath) {
      const { unlinkSync, rmSync } = await import('node:fs');
      try { unlinkSync(videoFilePath); } catch {}
      try { rmSync(videoFilePath.replace(/\/video_[^.]+\.mp4$/, ''), { recursive: true, force: true }); } catch {}
    }
  }
}
