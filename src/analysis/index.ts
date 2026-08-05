// ---------------------------------------------------------------------------
// Analysis Module — Public API
//
// One interface, two backends (gemini-native video + gemini-text fallback),
// same Zod schema out. Backend selection is a config flag on the workspace;
// model fallback (native on a second model when the primary 503s) is automatic
// and logged.
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
import { VideoAnalysisDataSchema, clampTimestamps } from './schema.js';
import { GeminiNativeAnalyzer } from './gemini-native.js';
import { GeminiTextAnalyzer } from './gemini-text.js';
import { OpenRouterVideoAnalyzer } from './openrouter-video.js';
import { loadAnalysisConfig, updateAnalysisConfig } from './config.js';
import { basisToConfidence, getCostCents, type AnalysisConfig, type AnalysisContext, type AnalysisResult, type VideoAnalyzer, DEFAULT_CONFIG } from './types.js';
import { resolveThumbUrl, signedMediaUrl } from '../lib/media.js';
import { classifyGeminiError } from '../lib/gemini-errors.js';
import { openRouterVideoEnabled } from '../lib/llm.js';

/**
 * A Gemini Files handle for this video that has not expired yet (Phase 2.2).
 *
 * The expiry stored is our own conservative window, not Google's — see
 * GEMINI_FILE_TTL_MS. If it has passed we return null and the backend uploads
 * again; if Google dropped the file earlier than we predicted, the backend
 * catches that and re-uploads once.
 */
function liveGeminiFile(video: {
  geminiFileUri: string | null;
  geminiFileName: string | null;
  geminiFileExpiresAt: Date | null;
}): { uri: string; name: string } | null {
  if (!video.geminiFileUri || !video.geminiFileName || !video.geminiFileExpiresAt) return null;
  if (video.geminiFileExpiresAt.getTime() <= Date.now()) return null;
  return { uri: video.geminiFileUri, name: video.geminiFileName };
}

// ---------------------------------------------------------------------------
// Factory — create the right backend from config
// ---------------------------------------------------------------------------

function createBackend(id: string, config: AnalysisConfig, model?: string): VideoAnalyzer {
  switch (id) {
    case 'gemini-native': return new GeminiNativeAnalyzer(config, model ? { model } : undefined);
    case 'gemini-text': return new GeminiTextAnalyzer(config);
    case 'openrouter-video': return new OpenRouterVideoAnalyzer();
    default: throw new Error(`Unknown analysis backend: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Backend/model attempt planning
//
// Growth from a two-element chain to three:
//   1. primary backend, primary model  (gemini-native + geminiModel)
//   2. same-backend model fallback     (gemini-native + fallbackModel) — the
//      paid-API survival play: when gemini-3.5-flash 503s, a different video
//      model bucket (default gemini-3.5-flash-lite) can still do shot-level
//      analysis instead of dropping straight to a camera-blind text call.
//   3. configured backend fallback     (usually gemini-text)
//
// Pure and unit-tested (src/analysis/index.test.ts) so pricing/ordering holds
// independent of the DB/network. The runtime loop additionally skips (2) when
// the primary failure was deterministic (see the gate in analyzeVideo below).
// ---------------------------------------------------------------------------

export interface BackendAttempt {
  /** Analyzer to run: 'gemini-native' | 'gemini-text' | 'openrouter-video'. */
  backendId: string;
  /** Set only on the native model-fallback attempt. */
  model?: string;
  /** Suffix for the stored Analysis.backend string, e.g. ' (fallback model)'. */
  label?: string;
  /** True for any non-primary attempt (logging + surface tagging). */
  fallback?: boolean;
}

export function planBackendAttempts(
  config: AnalysisConfig,
  opts?: { forceBackend?: string; flipToFallback?: boolean; orVideoEnabled?: boolean },
): BackendAttempt[] {
  // After MAX_FAILURES consecutive failures the primary is swapped for the
  // configured fallback for an hour (see analyzeVideo) — go straight there.
  const primaryBackend = opts?.flipToFallback ? config.fallback : (opts?.forceBackend ?? config.backend);
  const fallbackBackend = config.fallback;
  const attempts: BackendAttempt[] = [{ backendId: primaryBackend }];

  const fallbackModel = config.fallbackModel && config.fallbackModel !== config.geminiModel
    ? config.fallbackModel
    : undefined;

  if (primaryBackend === 'gemini-native' && fallbackModel) {
    attempts.push({ backendId: 'gemini-native', model: fallbackModel, label: ' (fallback model)', fallback: true });
  }

  // OpenRouter video (model via OPENROUTER_VIDEO_MODEL) sits between the Google
  // native attempts and the text fallback — a shot-level analysis on a billed
  // OpenRouter key when Google can't, before we drop to camera-blind text.
  const orVideo = opts?.orVideoEnabled ?? openRouterVideoEnabled();
  if (primaryBackend === 'gemini-native' && orVideo && !attempts.some(a => a.backendId === 'openrouter-video')) {
    attempts.push({ backendId: 'openrouter-video', label: ' (fallback)', fallback: true });
  }

  if (fallbackBackend && fallbackBackend !== primaryBackend
    && !attempts.some(a => a.backendId === fallbackBackend && !a.model)) {
    attempts.push({ backendId: fallbackBackend, label: ' (fallback)', fallback: true });
  }
  return attempts;
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

  // Signed URL for the STORED copy of the video, only when the openrouter-video
  // backend might run (avoids an extra storage round-trip on every analysis).
  const storedMedia = openRouterVideoEnabled() ? await signedMediaUrl(video) : { url: null };

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
    thumbImageUrl: resolveThumbUrl(video),
    geminiFile: liveGeminiFile(video),
    storedMediaUrl: storedMedia.url,
    videoFilePath: options?.videoFilePath,
    batch,
  };

  // 4. Determine backend chain (DB-backed failure check)
  const primaryFailureCount = await getFailureCount(workspaceId, config.backend);
  const primaryBackend = options?.forceBackend ?? config.backend;
  const fallbackBackend = config.fallback;
  const flipToFallback = primaryFailureCount >= MAX_FAILURES_BEFORE_FALLBACK && primaryBackend !== fallbackBackend;

  if (flipToFallback) {
    console.warn(`[analysis] ${primaryBackend} has ${primaryFailureCount} consecutive failures (persisted), using fallback: ${fallbackBackend}`);
  }

  // 5. Try primary -> same-capability model fallback -> configured fallback.
  const attempts = planBackendAttempts(config, { forceBackend: options?.forceBackend, flipToFallback });

  let lastError: Error | null = null;
  // The model fallback is worth trying only after a retryable failure (5xx /
  // 429 / timeout — a capacity or transient problem a different model bucket
  // can sidestep). A deterministic failure (bad key, malformed input, schema
  // rejection) would recur identically on the second model, so skip it rather
  // than burn paid tokens; the text fallback still gets its chance.
  let lastErrorRetryable = true;

  for (const attempt of attempts) {
    const { backendId, model } = attempt;

    if (model && lastError && !lastErrorRetryable) {
      console.log(`[analysis] skipping model fallback (${model}) — previous ${attempt.backendId} error is deterministic, not worth a second paid call`);
      continue;
    }

    // gemini-native needs the video to exist SOMEWHERE it can reach: either a
    // local file to upload, or a live Files API handle from a previous run
    // (Phase 2.2), in which case Gemini already holds it and no local copy is
    // needed. Checking only videoFilePath would send every cache hit — the case
    // 2.2 exists to create — straight to the text fallback.
    if (backendId === 'gemini-native' && !ctx.videoFilePath && !ctx.geminiFile) {
      console.log(`[analysis] ${backendId} has neither a video file nor a live Gemini file, skipping to text-only fallback`);
      continue;
    }
    // openrouter-video needs either a stored-media URL (URL mode) or the local
    // file (base64 mode) — otherwise there is no clip to send it.
    if (backendId === 'openrouter-video' && !ctx.videoFilePath && !ctx.storedMediaUrl) {
      console.log(`[analysis] openrouter-video has neither a stored video URL nor a local file, skipping to text-only fallback`);
      continue;
    }

    const backend = createBackend(backendId, config, model);
    const isFallback = attempt.fallback === true;

    try {
      console.log(`[analysis] Running ${backend.name}${attempt.label ?? ''} on video ${videoId}${model ? ` (model ${model})` : ''}${isFallback ? ' (FALLBACK)' : ''}${batch ? ' (BATCH)' : ''}...`);
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
      //
      // Clamp before persisting, not on read: these timestamps are now seeked
      // to (get_video turns key moments into #t= fragments), and a value past
      // the end of the video renders a blank frame. Zod cannot bound them —
      // the limit is this row's duration, which the schema never sees.
      const clamped = clampTimestamps(output.data, video.durationSec);

      // Phase 2.2: keep the Files API handle so the next analysis of this video
      // skips the upload. Best-effort — losing the cache must not lose the run.
      if (output.geminiFile) {
        await db.video.update({
          where: { id: videoId },
          data: {
            geminiFileUri: output.geminiFile.uri,
            geminiFileName: output.geminiFile.name,
            geminiFileExpiresAt: output.geminiFile.expiresAt,
          },
        }).catch(err => console.warn(`[analysis] could not persist Gemini file handle: ${(err as Error).message}`));
      }

      const saved = await db.analysis.create({
        data: {
          videoId,
          schemaVersion: 'v3',
          analysisJson: JSON.stringify(clamped),
          analysisBasis: output.analysisBasis,
          backend: output.backend + (attempt.label ?? '') + (batch ? ' (batch)' : ''),
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
        backend: output.backend + (attempt.label ?? '') + (batch ? ' (batch)' : ''),
        model: output.model,
        costCents,
      };

    } catch (err) {
      lastError = err as Error;
      lastErrorRetryable = classifyGeminiError(err).retryable;
      if (workspaceId !== 'unknown') {
        const newCount = await recordFailure(workspaceId, backendId);
        console.error(`[analysis] ${backend.name} failed for video ${videoId}: ${(err as Error).message} (failure count for ${backendId}: ${newCount})`);
      } else {
        console.error(`[analysis] ${backend.name} failed for video ${videoId}:`, (err as Error).message);
      }
      // Try next attempt in the chain (primary -> model fallback -> fallback).
      continue;
    }
  }

  throw new Error(
    `All analysis backends failed for video ${videoId}. ` +
    `Last error: ${lastError?.message}. ` +
    `Backends tried: [${attempts.map(a => a.backendId + (a.model ? `:${a.model}` : '')).join(', ')}]`,
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

  // The openrouter-video backend can send the clip by URL when it is STORED
  // (URL mode — no download); otherwise it needs the local file for base64.
  const storedMedia = openRouterVideoEnabled() ? await signedMediaUrl(video).catch(() => ({ url: null as string | null })) : { url: null as string | null };
  const needsFile = backend === 'gemini-native'
    || (openRouterVideoEnabled() && !storedMedia.url);

  // If the backend needs a video file, download it via Apify.
  //
  // TikTok only: downloadTikTokVideo drives the clockworks/tiktok-scraper
  // actor, so a reels/shorts URL would pre-authorize spend against the cap
  // and then fail inside the actor. Those platforms have no scraper yet
  // (scrapeSource throws for both), but create_source still accepts them —
  // so the guard is on platform, not on whether a row can exist.
  // Phase 2.2: with a live Files API handle there is nothing to download OR
  // upload — Gemini already holds the video. This is the case §2.2 called
  // "needs no download at all, from any source", and it skips both the Apify
  // call and the Storage read that Phase 2.1 added.
  const cachedGeminiFile = liveGeminiFile(video);

  let videoFilePath: string | undefined;
  if (cachedGeminiFile) {
    console.log(`[analysis] Gemini still holds ${videoId} — skipping download and upload`);
  } else if (needsFile && video.platform === 'tiktok' && video.url && workspaceId) {
    try {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { downloadTikTokVideo } = await import('../lib/apify.js');

      const tmpDir = mkdtempSync(join(tmpdir(), 'slashloop-'));
      videoFilePath = join(tmpDir, `video_${videoId.slice(0, 8)}.mp4`);

      // Phase 2.1 (docs/media-storage-plan.md §2.1): if we already hold the
      // MP4, pull it from Storage instead of paying Apify to fetch it again.
      //
      // This is not only a cost saving. Measured on 2026-07-29, the Apify actor
      // leg is roughly 15-20s of the worker's 60s budget, and a gemini-native
      // run was timing out inside generateContent with the download already
      // behind it. Reclaiming that time is what gives the analysis room to
      // finish, so treat this as part of the timeout fix, not just a discount.
      //
      // No spend is recorded and no cap is asserted on this path, because no
      // Apify call is made.
      const { fetchStoredVideo } = await import('../lib/media.js');
      const cached = video.mediaKey && video.mediaStatus === 'stored'
        ? await fetchStoredVideo(video.mediaKey, videoFilePath)
        : null;

      if (cached) {
        console.log(`[analysis] Reusing stored MP4 (${(cached.bytes / 1024 / 1024).toFixed(2)}MB) — skipped Apify`);
      } else {
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

        // Cache the MP4 so a re-analysis inside the retention window doesn't
        // have to pay Apify again. Never throws — the download already
        // succeeded and the analysis is about to run; losing the cache copy
        // must not lose the analysis.
        const { ingestVideoFile } = await import('../lib/media.js');
        await ingestVideoFile(workspaceId, videoId, videoFilePath);
      }
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
