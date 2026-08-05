// ---------------------------------------------------------------------------
// OpenRouter Video Analyzer — shot-level video analysis through OpenRouter.
//
// When OPENROUTER_VIDEO_MODEL is set, this becomes the native-video backend:
// the same gemini-observe prompt is sent to a video-capable OpenRouter model
// (qwen, bytedance-seed, stepfun, z-ai/glm-5v, ... — see the matrix in the
// llm.ts header), and the video travels as either:
//   - a signed Supabase storage URL (mode `url` / `auto` when stored), or
//   - a base64 data URL of the local MP4 (mode `base64` / `auto` fallback).
//
// This is what keeps producing real shot-level analyses (shots, keyMoments,
// onScreenText, audio) when GEMINI_API_KEY can't (free-tier 503/429) and
// OpenRouter has no Files-API upload — the observed video reaches the model
// over its OpenAI-compatible video_url part instead.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { VideoAnalysisDataSchema } from './schema.js';
import type { VideoAnalyzer, AnalysisContext, AnalysisOutput } from './types.js';
import { loadPromptTemplate, buildUserMessage } from './gemini-native.js';
import { callOpenRouterVideo, extractFirstJson } from '../lib/openrouter.js';
import { openRouterVideoConfig } from '../lib/llm.js';

/** Cap for base64-inlined videos. Above this, base64 bodies get unwieldy and
 *  providers may reject them — fall back to text. URL mode has no such cap. */
const MAX_BASE64_BYTES = 15 * 1024 * 1024;

export class OpenRouterVideoAnalyzer implements VideoAnalyzer {
  readonly name = 'OpenRouter Video';
  readonly backendId = 'openrouter-video';
  readonly provider = 'openrouter';
  private model: string;

  constructor() {
    // Env-driven: OPENROUTER_VIDEO_MODEL picks the provider/model (default qwen).
    this.model = openRouterVideoConfig().model;
  }

  async analyze(ctx: AnalysisContext): Promise<AnalysisOutput> {
    const videoUrl = await this.resolveVideoUrl(ctx);
    if (!videoUrl) {
      throw new Error('OpenRouter video needs either stored media (URL mode) or a local video file (base64 mode).');
    }

    const template = loadPromptTemplate();
    const userText = buildUserMessage(ctx, template);

    const result = await callOpenRouterVideo(template, userText, this.model, videoUrl);

    // Reasoning models (qwen3.7, stepfun, glm) pad output with a thinking
    // preamble; extract the first JSON object and validate it like every
    // other backend.
    const parsed = extractFirstJson(result.rawText);
    if (!parsed) {
      throw new Error(`OpenRouter video returned unparsable output: ${result.rawText.slice(0, 140)}`);
    }
    const validated = VideoAnalysisDataSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`OpenRouter video output failed schema validation: ${validated.error?.issues.map(i => i.message).join(', ')}`);
    }

    const hasTranscript = !!(ctx.transcript?.trim());
    const analysisBasis = hasTranscript ? 'video+transcript' : 'video';

    return {
      data: validated.data,
      analysisBasis,
      backend: this.backendId,
      model: this.model,
      // Billed by OpenRouter per token (metered by their account, not the
      // credit ledger). Kept 0 here; the workspace credit meter is unchanged.
      costCents: 0,
      provider: this.provider,
    };
  }

  /** URL mode when we have stored media, else base64 of the local file. */
  private async resolveVideoUrl(ctx: AnalysisContext): Promise<string | null> {
    const cfg = openRouterVideoConfig();
    const wantUrl = cfg.mode === 'url' || (cfg.mode === 'auto' && !!ctx.storedMediaUrl);
    if (wantUrl && ctx.storedMediaUrl) return ctx.storedMediaUrl;

    const wantBase64 = cfg.mode === 'base64' || (cfg.mode === 'auto' && !ctx.storedMediaUrl);
    if (wantBase64 && ctx.videoFilePath) {
      const bytes = readFileSync(ctx.videoFilePath);
      if (bytes.byteLength > MAX_BASE64_BYTES) {
        console.warn(`[openrouter-video] video too large for base64 (${(bytes.byteLength / 1e6).toFixed(1)}MB > 15MB) — skipping to text`);
        return null;
      }
      return `data:video/mp4;base64,${bytes.toString('base64')}`;
    }
    return null;
  }
}
