// ---------------------------------------------------------------------------
// Gemini Text-Only Analyzer — fallback backend.
//
// Same Gemini model as GeminiNativeAnalyzer, but with no `file_data` part —
// it reads the transcript + caption + metadata + thumbnail URL as text.
// This is the automatic fallback when native video upload fails (video too
// large, Apify download timeout, missing APIFY_API_KEY, etc.).
//
// With this backend you can run the whole slashloop pipeline using only
// GEMINI_API_KEY — no other AI provider key is required.
//
// Cost: ~$0.0005–0.001 per call on gemini-3.5-flash (text-only is much
// cheaper than native video understanding).
// ---------------------------------------------------------------------------

import { VideoAnalysisDataSchema, type VideoAnalysisData } from './schema.js';
import type { VideoAnalyzer, AnalysisContext, AnalysisOutput } from './types.js';
import { getCostCents } from './types.js';
import type { AnalysisConfig } from './types.js';
import { callModelText, activeProvider } from '../lib/llm.js';
import { createRequire } from 'node:module';

// Lazy like gemini-native's loader: node:fs / import.meta.url must not run at
// module scope (Workers crash on startup otherwise; analysis is VPS work).
let cachedPrompt: string | undefined;

function loadPromptTemplate(): string {
  if (cachedPrompt === undefined) {
    const req = createRequire(import.meta.url);
    const { fileURLToPath } = req('node:url');
    const { dirname, resolve } = req('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const loaded = req('node:fs').readFileSync(resolve(here, '../../prompts/gemini-text.v1.md'), 'utf-8');
    cachedPrompt = loaded;
    return loaded;
  }
  return cachedPrompt;
}

/**
 * `imageCount` is how many images were actually attached, not how many URLs
 * existed. The basis drives confidence language in the prompt and gates
 * canExtractHook downstream, so claiming a thumbnail we failed to fetch would
 * overstate what the model saw. Two or more images means a photo carousel.
 */
export function determineBasis(ctx: AnalysisContext, imageCount: number): string {
  const hasTranscript = !!(ctx.transcript?.trim());
  const hasCaption = !!(ctx.caption?.trim());
  const hasThumbnail = imageCount > 0;

  if (imageCount >= 2) return 'slideshow+caption';
  if (hasTranscript && hasThumbnail) return 'transcript+thumbnail';
  if (hasTranscript) return 'transcript-only';
  if (hasThumbnail && hasCaption) return 'thumbnail+caption';
  return 'caption+metadata-only';
}

function basisDescription(basis: string, slideCount = 0): string {
  const map: Record<string, string> = {
    'transcript+thumbnail': 'You have a full transcript AND the thumbnail image itself, attached. High confidence on verbal content; medium confidence on visual techniques — describe only what is visible in that one frame.',
    'transcript-only': 'You have a full transcript but no thumbnail. High confidence on verbal content; lower confidence on visuals.',
    'thumbnail+caption': 'You have the thumbnail image itself, attached, plus the caption, but NO transcript. Medium confidence. Describe only what is visible in that one frame, and do NOT make claims about spoken content.',
    'slideshow+caption': `You have a photo carousel of ${slideCount} slides attached IN ORDER (image 1 = first slide, image ${slideCount} = last), plus the caption. NO video and NO transcript. High confidence on visuals — you can see every slide. Analyze EACH slide, not just the first. Do NOT make claims about spoken content.`,
    'caption+metadata-only': 'You have only the caption and engagement metadata. Lowest confidence. Focus on metadata signals. Do NOT make claims about visual or audio content.',
  };
  return map[basis] ?? 'Unknown basis';
}

function visualRules(basis: string, slideCount: number): string {
  if (basis === 'slideshow+caption') {
    return `This is a photo carousel of ${slideCount} slides, not a video. The attached images are the slides in display order. Analyze EVERY slide.
- \`shots\` MUST have exactly ${slideCount} entries (one per slide). \`timestampSec\` = 0-based slide index, \`durationSec\` = 0. \`description\` is REQUIRED and must be 1–2 sentences of what is actually visible (subject, framing, background, clothing, expression) — never an empty string. \`type\` should classify the frame (text_overlay, product_closeup, talking_head, other, …). \`onScreenText\` on the shot is the text you can read, or null if none.
- \`onScreenText\` (top-level) MUST list readable text per slide (\`timestampSec\` = slide index). Quote the words; do not paraphrase.
- \`keyMoments\` MUST be 3–6 restageable frames. \`timestampSec\` = slide index. \`subjectAction\` is REQUIRED — an imperative instruction a creator could perform ("Face camera unsmiling, even studio light"), never empty. Fill framing, cameraAngle, lighting, and textOverlay from what you see.
- \`audioAnalysis\` and \`emotionalArc\` must be null. \`pacing.cutsPerMinute\` must be null.`;
  }
  return 'Set null for unobservable fields. You cannot see the video, so `shots`, `onScreenText`, `audioAnalysis`, `emotionalArc`, and `keyMoments` must all be `null`. The `pacing.cutsPerMinute` must be `null`.';
}

/** Reject a carousel analysis that listed slides but described none of them. */
export function assertSlideshowVisuals(data: VideoAnalysisData, slideCount: number): void {
  const shots = data.shots;
  if (!Array.isArray(shots) || shots.length < Math.min(2, slideCount)) {
    throw new Error(`slideshow analysis must include one shot per slide (got ${shots?.length ?? 0}, expected ${slideCount})`);
  }
  const blankShots = shots.filter(s => !s.description?.trim()).length;
  if (blankShots) {
    throw new Error(`slideshow shots missing visual description on ${blankShots} slide(s)`);
  }
  const moments = data.keyMoments;
  if (Array.isArray(moments) && moments.length) {
    const blankMoments = moments.filter(m => !m.subjectAction?.trim()).length;
    if (blankMoments) {
      throw new Error(`slideshow keyMoments missing subjectAction on ${blankMoments} moment(s)`);
    }
  }
}

function outputVisualSchema(basis: string): string {
  if (basis === 'slideshow+caption') {
    return `"keyMoments": [
    {"timestampSec": 0, "role": "hook", "framing": "close_up", "cameraAngle": "eye_level", "cameraMovement": "static", "subjectAction": "REQUIRED: imperative restage instruction for this slide", "wardrobeProps": null, "setting": "what is behind the subject", "lighting": "what the light is doing", "textOverlay": {"text": "words on the slide", "position": "bottom", "style": null}, "transitionIn": "none", "audioAtMoment": null}
  ],
  "shots": [
    {"timestampSec": 0, "durationSec": 0, "type": "text_overlay", "description": "REQUIRED: 1-2 sentences of what is visible on this slide", "onScreenText": "exact overlay text or null"}
  ],
  "onScreenText": [
    {"timestampSec": 0, "text": "exact words readable on this slide", "style": "overlay"}
  ],
  "audioAnalysis": null,
  "emotionalArc": null,`;
  }
  return `"keyMoments": null,
  "shots": null,
  "onScreenText": null,
  "audioAnalysis": null,
  "emotionalArc": null,`;
}

/** Cover images are ~60-600KB; this is a sanity ceiling, not a real limit. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_ANALYSIS_SLIDES = 16;
const COVER_FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch a cover image as base64 for an inline image part.
 *
 * Returns null on any failure — a missing cover degrades this backend to
 * caption+metadata, which is what it did before images existed. It must never
 * fail the analysis: this IS the fallback path, and the thing it falls back
 * from has usually just failed too.
 */
async function fetchCoverImage(
  url: string | null | undefined,
): Promise<{ mimeType: string; dataBase64: string } | null> {
  if (!url?.trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`cover fetch ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 512) throw new Error(`cover too small (${buf.byteLength}b)`);
    if (buf.byteLength > MAX_COVER_BYTES) throw new Error(`cover too large (${buf.byteLength}b)`);

    const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // Storage serves these as image/jpeg (see imageContentType in lib/media.ts),
    // but fall back rather than send something Gemini will reject.
    const mimeType = header.startsWith('image/') ? header : 'image/jpeg';

    return { mimeType, dataBase64: buf.toString('base64') };
  } catch (err) {
    console.warn(`[gemini-text] no cover image (${(err as Error).message}) — analysing on text alone`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class GeminiTextAnalyzer implements VideoAnalyzer {
  readonly name = 'Gemini Text-Only (Frames Fallback)';
  readonly backendId = 'gemini-text';
  readonly provider = 'google';
  private model: string;

  constructor(config?: AnalysisConfig) {
    this.model = config?.geminiModel ?? 'gemini-3.5-flash';
  }

  async analyze(ctx: AnalysisContext): Promise<AnalysisOutput> {
    const template = loadPromptTemplate();

    const followers = ctx.creatorFollowers?.toLocaleString() ?? 'unknown';
    const duration = ctx.durationSec ?? 'unknown';
    const outlierScore = ctx.outlierScore?.toFixed(1) ?? 'N/A';
    const outlierExplanation = ctx.outlierExplanation ?? 'no score yet';
    const shares = ctx.shares?.toLocaleString() ?? 'N/A';
    const saves = ctx.saves?.toLocaleString() ?? 'N/A';

    let transcriptSection = '\n- **Transcript**: *No transcript available.*';
    if (ctx.transcript?.trim()) {
      transcriptSection = `\n- **Transcript**:\n\`\`\`\n${ctx.transcript}\n\`\`\``;
    }

    // Fetch attached images as real image parts. Photo carousels send every
    // stored slide; a regular video still sends the single cover.
    const imageUrls = (ctx.slideImageUrls?.length
      ? ctx.slideImageUrls
      : [ctx.thumbImageUrl ?? ctx.thumbnailUrl]
    ).filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
    const images: Array<{ mimeType: string; dataBase64: string }> = [];
    for (const url of imageUrls.slice(0, MAX_ANALYSIS_SLIDES)) {
      const got = await fetchCoverImage(url);
      if (got) images.push(got);
    }
    const analysisBasis = determineBasis(ctx, images.length);
    const thumbnailSection = images.length >= 2
      ? `\n- **Slides**: ${images.length} carousel images attached in order — analyze each slide, not only the first.`
      : images.length === 1
        ? '\n- **Thumbnail**: attached as an image — describe only what you can actually see in it.'
        : '';

    const userMessage = template
      .replace(/{platform}/g, ctx.platform)
      .replace(/{creatorHandle}/g, ctx.creatorHandle)
      .replace(/{followers}/g, followers)
      .replace(/{postedAt}/g, ctx.postedAt)
      .replace(/{views}/g, ctx.views.toLocaleString())
      .replace(/{likes}/g, ctx.likes.toLocaleString())
      .replace(/{comments}/g, ctx.comments.toLocaleString())
      .replace(/{shares}/g, shares)
      .replace(/{saves}/g, saves)
      .replace(/{duration}/g, String(duration))
      .replace(/{outlierScore}/g, outlierScore)
      .replace(/{outlierExplanation}/g, outlierExplanation)
      .replace(/{analysisBasis}/g, analysisBasis)
      .replace(/{basis_description}/g, basisDescription(analysisBasis, images.length))
      .replace(/{visual_rules}/g, visualRules(analysisBasis, images.length))
      .replace(/{output_visual_schema}/g, outputVisualSchema(analysisBasis))
      .replace(/{caption}/g, ctx.caption || '*No caption.*')
      .replace(/{transcript_section}/g, transcriptSection)
      .replace(/{thumbnail_section}/g, thumbnailSection);

    console.log(`[gemini-text] Analyzing ${ctx.videoId} with ${this.model} (basis: ${analysisBasis}, images: ${images.length})${ctx.batch ? ' (BATCH)' : ''}...`);

    const result = await callModelText(template, userMessage, this.model,
      images.length ? { images } : undefined);

    const validated = VideoAnalysisDataSchema.safeParse(result.parsed);
    if (!validated.success) {
      console.error('[gemini-text] Schema validation errors:', validated.error?.issues);
      throw new Error(`Gemini text output failed schema validation: ${validated.error?.issues.map(i => i.message).join(', ')}`);
    }
    if (analysisBasis === 'slideshow+caption') {
      assertSlideshowVisuals(validated.data, images.length);
    }

    const costCents = getCostCents('gemini-text', this.model, ctx.batch ?? false) || 0.1;

    return {
      data: validated.data,
      analysisBasis,
      backend: this.backendId,
      model: this.model,
      costCents,
      // 'google' or 'openrouter' — whichever provider actually served the call
      // (the factory picks by env; authed via the active provider's key).
      provider: activeProvider(),
    };
  }
}
