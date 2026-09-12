// Recreate a TikTok photo carousel via OpenRouter GPT-image-2.5 sunburst
// at low quality so a 4–8 slide restage stays cheap.

import { z } from 'zod/v4';
import { db } from '../db.js';
import { generateOpenRouterImage } from './openrouter.js';
import { persistRecreation, resolveSlideshowUrls, isPhotoPost } from './media.js';
import { callGeminiGenerate, GeminiNativeAnalyzer, isStaleFileError } from '../analysis/gemini-native.js';
import { liveGeminiFile } from '../analysis/index.js';
import { SLIDESHOW_PLAN_TEMPLATE } from './slideshow-plan-prompt.js';

// TikTok photo mode caps posts at 35 photos — restage every stored slide,
// not just the first 8 (14+ slide carousels are common).
export const MAX_RECREATE_SLIDES = 35;

export function buildRecreateSlidePrompt(opts: {
  slideIndex: number;
  slideCount: number;
  caption: string;
  description?: string;
  onScreenText?: string;
}): string {
  const bits = [
    `Recreate TikTok photo-carousel slide ${opts.slideIndex + 1} of ${opts.slideCount} as a new original 9:16 image.`,
    'Match composition, lighting, graphic style, and overlay layout of the reference photo.',
  ];
  if (opts.onScreenText?.trim()) bits.push(`Keep this on-screen text exactly: "${opts.onScreenText.trim()}".`);
  if (opts.description?.trim()) bits.push(`Scene: ${opts.description.trim()}`);
  if (opts.caption?.trim()) bits.push(`Post caption (context only): ${opts.caption.trim().slice(0, 280)}`);
  bits.push('No TikTok UI, no watermarks, no platform chrome.');
  return bits.join(' ');
}

function shotNotes(analysisJson: string | null, index: number): { description?: string; onScreenText?: string } {
  if (!analysisJson) return {};
  try {
    const data = JSON.parse(analysisJson) as {
      shots?: Array<{ timestampSec?: number; description?: string; onScreenText?: string | null }>;
      onScreenText?: Array<{ timestampSec?: number; text?: string }>;
    };
    const shot = (data.shots ?? []).find(s => s.timestampSec === index) ?? data.shots?.[index];
    const overlay = (data.onScreenText ?? []).find(s => s.timestampSec === index);
    return {
      description: shot?.description?.trim() || undefined,
      onScreenText: (typeof shot?.onScreenText === 'string' && shot.onScreenText.trim())
        ? shot.onScreenText.trim()
        : overlay?.text?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export async function recreateSlideshowForVideo(
  workspaceId: string,
  videoId: string,
): Promise<{ keys: string[]; slides: number; costUsd: number }> {
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId } },
    select: { id: true, caption: true, rawJson: true, mediaStatus: true, durationSec: true, thumbnailUrl: true },
  });
  if (!video) throw new Error('Video not found.');
  if (!isPhotoPost(video)) {
    // Videos are NOT restaged here. The ffmpeg extraction path was removed:
    // video slideshows are built by the Workers-native stepper
    // (recreate-video-stream.ts) on the Cloudflare Worker, with Cloudflare
    // Stream as the frame server. The queue claim (claimNextJob) filters
    // video-mode rows away from this drainer entirely.
    throw new Error('Video slideshows are built by the Workers stepper (Stream), not the VPS worker.');
  }
  const originals = resolveSlideshowUrls(video.rawJson);
  if (!originals.length) throw new Error('Store the original slides before recreating them.');

  const latest = await db.analysis.findFirst({
    where: { videoId },
    orderBy: { createdAt: 'desc' },
    select: { analysisJson: true },
  });

  const urls = originals.slice(0, MAX_RECREATE_SLIDES);
  const slides: Array<{ buffer: Buffer; contentType: string }> = [];
  let costUsd = 0;
  for (let i = 0; i < urls.length; i++) {
    const notes = shotNotes(latest?.analysisJson ?? null, i);
    const prompt = buildRecreateSlidePrompt({
      slideIndex: i,
      slideCount: urls.length,
      caption: video.caption,
      description: notes.description,
      onScreenText: notes.onScreenText,
    });
    const img = await generateOpenRouterImage({
      prompt,
      referenceUrl: urls[i],
      quality: 'low',
      aspectRatio: '9:16',
    });
    if (img.buffer.length < 512) throw new Error(`recreated slide ${i + 1} too small`);
    slides.push({ buffer: img.buffer, contentType: img.contentType });
    costUsd += img.costUsd;
    console.log(`[recreate] slide ${i + 1}/${urls.length} for ${videoId} ($${img.costUsd.toFixed(4)})`);
  }

  const keys = await persistRecreation(workspaceId, videoId, slides);
  return { keys, slides: keys.length, costUsd };
}

// ---------------------------------------------------------------------------
// Video → slideshow shared pieces: the Gemini slide-plan call and the
// overlay-dropping slide prompt.
//
// Frame EXTRACTION lives on the Workers side only (recreate-video-stream.ts +
// stream-frames.ts): Cloudflare Stream returns a JPEG at any timestamp, so
// there is no ffmpeg anywhere in this pipeline. The VPS drainer never builds
// video slideshows — claimNextJob filters video-mode recreate rows away from
// it, and its recreate dispatcher rejects them defensively.
// ---------------------------------------------------------------------------

export const MAX_VIDEO_SLIDES = 8;

const VideoSlidePlanSchema = z.object({
  slides: z.array(z.object({
    tSec: z.number().min(0),
    description: z.string().min(1),
    overlayText: z.string().nullable().catch(null),
  })).min(1),
});

export type VideoSlidePlan = z.infer<typeof VideoSlidePlanSchema>;

export interface VideoSlidePlanResult {
  plan: VideoSlidePlan;
  model: string;
  source: 'gemini' | 'gemini-reused-file' | 'fallback-interval';
}

let cachedPlanPrompt: string | undefined;

// A TS constant, not a prompts/*.md read: the plan runs on the Workers-native
// Stream path too, and workerd cannot read files (see slideshow-plan-prompt.ts).
export function loadSlideshowPlanTemplate(): string {
  if (cachedPlanPrompt === undefined) cachedPlanPrompt = SLIDESHOW_PLAN_TEMPLATE;
  return cachedPlanPrompt;
}

export function buildSlideshowPlanUserMessage(ctx: {
  creatorHandle: string | null;
  durationSec: number | null;
  caption: string | null;
}): string {
  return loadSlideshowPlanTemplate()
    .replace(/{creatorHandle}/g, ctx.creatorHandle?.trim() || 'unknown')
    .replace(/{duration}/g, String(ctx.durationSec ?? 'unknown'))
    .replace(/{caption}/g, ctx.caption?.trim() || '*No caption.*');
}

/** Validate, sort, drop near-duplicate timestamps and cap the plan. */
export function normalizeSlidePlan(parsed: unknown, durationSec: number | null): VideoSlidePlan {
  const validated = VideoSlidePlanSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`slide plan failed schema validation: ${validated.error.issues.map(i => i.message).join(', ')}`);
  }
  const maxT = durationSec != null && durationSec > 0 ? Math.max(durationSec - 0.3, 0) : null;
  const kept: number[] = [];
  const slides = validated.data.slides
    .map(s => ({ ...s, tSec: maxT != null ? Math.min(s.tSec, maxT) : s.tSec }))
    .sort((a, b) => a.tSec - b.tSec)
    .filter(s => {
      // Two slides inside the same 2s read as near-duplicates in a carousel.
      if (kept.some(t => Math.abs(t - s.tSec) < 2)) return false;
      kept.push(s.tSec);
      return true;
    })
    .slice(0, MAX_VIDEO_SLIDES);
  if (!slides.length) throw new Error('slide plan had no usable slides');
  return { slides };
}

/** Degraded mode when Gemini planning fails: evenly spaced frames. */
export function fallbackIntervalPlan(durationSec: number | null, count = 6): VideoSlidePlan {
  const dur = durationSec && durationSec > 0 ? durationSec : 30;
  return {
    slides: Array.from({ length: Math.min(count, MAX_VIDEO_SLIDES) }, (_, i) => ({
      tSec: Number(((dur * (i + 0.5)) / count).toFixed(2)),
      description: '',
      overlayText: null,
    })),
  };
}

export const MIN_VIDEO_SLIDES = 3;

/**
 * Timestamps to actually cut. Short clips sometimes come back with a single
 * planned slide; a carousel needs a few, so top up with interval frames at
 * least 2s away from every pick (and from each other).
 */
export function planTimestamps(plan: VideoSlidePlan, durationSec: number | null): number[] {
  const timestamps = plan.slides.map(s => s.tSec);
  if (timestamps.length >= MIN_VIDEO_SLIDES) return timestamps;
  for (const t of fallbackIntervalPlan(durationSec, 6).slides.map(s => s.tSec)) {
    if (timestamps.length >= MIN_VIDEO_SLIDES) break;
    if (!timestamps.some(x => Math.abs(x - t) < 2)) timestamps.push(t);
  }
  return timestamps.sort((a, b) => a - b);
}

/**
 * Ask Gemini (same model as Analyze) where to cut the video into slideshow
 * keyframes. Reuses a live Files API handle when Analyze uploaded the video
 * within its stored window; otherwise uploads the stored MP4. A stale handle
 * re-uploads once, exactly like the analyzer.
 */
export async function planVideoSlides(opts: {
  videoId: string;
  /** The stored MP4, read from R2 — no filesystem involved. */
  videoBytes: Uint8Array;
  durationSec: number | null;
  creatorHandle: string | null;
  caption: string | null;
  geminiFile?: { uri: string; name: string } | null;
}): Promise<VideoSlidePlanResult> {
  const model = process.env.SLIDESHOW_PLAN_MODEL || 'gemini-3.5-flash';
  const template = loadSlideshowPlanTemplate();
  const userMessage = buildSlideshowPlanUserMessage({
    creatorHandle: opts.creatorHandle,
    durationSec: opts.durationSec,
    caption: opts.caption,
  });

  if (opts.geminiFile) {
    try {
      console.log(`[recreate] planning slides for ${opts.videoId} with ${model} (reusing uploaded file)...`);
      const { parsed } = await callGeminiGenerate(model, opts.geminiFile.uri, template, userMessage);
      return { plan: normalizeSlidePlan(parsed, opts.durationSec), model, source: 'gemini-reused-file' };
    } catch (err) {
      if (!isStaleFileError(err)) throw err;
      console.warn(`[recreate] stored file handle was stale, re-uploading: ${(err as Error).message}`);
    }
  }

  const analyzer = new GeminiNativeAnalyzer();
  const { fileUri } = await analyzer.uploadWithBuffer(opts.videoBytes);
  console.log(`[recreate] planning slides for ${opts.videoId} with ${model} (fresh upload)...`);
  const { parsed } = await callGeminiGenerate(model, fileUri, template, userMessage);
  return { plan: normalizeSlidePlan(parsed, opts.durationSec), model, source: 'gemini' };
}

export function buildVideoSlidePrompt(opts: {
  slideIndex: number;
  slideCount: number;
  caption: string;
  description?: string;
}): string {
  const bits = [
    `Recreate this video frame as a new original 9:16 image for a photo carousel (slide ${opts.slideIndex + 1} of ${opts.slideCount}).`,
    'Match the reference exactly: same subject, pose, wardrobe, setting, composition, camera framing, and lighting.',
    'Remove every trace of burned-in text and graphics — captions, subtitles, hook text, stickers, usernames, watermarks, platform logos, play buttons, progress bars, icons, any app UI — and continue the scene naturally behind them.',
    'The output must contain no text, no letters, no numbers, no logos, no watermarks, no UI of any kind.',
  ];
  if (opts.description?.trim()) bits.push(`Scene: ${opts.description.trim()}`);
  if (opts.caption?.trim()) bits.push(`Post caption (context only): ${opts.caption.trim().slice(0, 280)}`);
  return bits.join(' ');
}

