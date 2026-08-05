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

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoAnalysisDataSchema } from './schema.js';
import type { VideoAnalyzer, AnalysisContext, AnalysisOutput } from './types.js';
import { getCostCents } from './types.js';
import type { AnalysisConfig } from './types.js';
import { callModelText, activeProvider } from '../lib/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '../../prompts/gemini-text.v1.md');

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, 'utf-8');
}

/**
 * `hasThumbnail` means an image was actually attached, not that a URL existed.
 * The distinction is new and load-bearing: the basis drives confidence language
 * in the prompt and gates canExtractHook downstream, so claiming a thumbnail we
 * failed to fetch would overstate what the model saw.
 */
function determineBasis(ctx: AnalysisContext, hasThumbnail: boolean): string {
  const hasTranscript = !!(ctx.transcript?.trim());
  const hasCaption = !!(ctx.caption?.trim());

  if (hasTranscript && hasThumbnail) return 'transcript+thumbnail';
  if (hasTranscript) return 'transcript-only';
  if (hasThumbnail && hasCaption) return 'thumbnail+caption';
  return 'caption+metadata-only';
}

function basisDescription(basis: string): string {
  const map: Record<string, string> = {
    'transcript+thumbnail': 'You have a full transcript AND the thumbnail image itself, attached. High confidence on verbal content; medium confidence on visual techniques — describe only what is visible in that one frame.',
    'transcript-only': 'You have a full transcript but no thumbnail. High confidence on verbal content; lower confidence on visuals.',
    'thumbnail+caption': 'You have the thumbnail image itself, attached, plus the caption, but NO transcript. Medium confidence. Describe only what is visible in that one frame, and do NOT make claims about spoken content.',
    'caption+metadata-only': 'You have only the caption and engagement metadata. Lowest confidence. Focus on metadata signals. Do NOT make claims about visual or audio content.',
  };
  return map[basis] ?? 'Unknown basis';
}

/** Cover images are ~60-600KB; this is a sanity ceiling, not a real limit. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;
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

    // Fetch the cover and send it as an image part, rather than pasting a URL
    // into the prompt. The model cannot open URLs; the old version described a
    // link and then asked for visual analysis, which is why this backend's
    // output was thin whenever it ran.
    const cover = await fetchCoverImage(ctx.thumbImageUrl ?? ctx.thumbnailUrl);
    const analysisBasis = determineBasis(ctx, !!cover);
    const thumbnailSection = cover
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
      .replace(/{basis_description}/g, basisDescription(analysisBasis))
      .replace(/{caption}/g, ctx.caption || '*No caption.*')
      .replace(/{transcript_section}/g, transcriptSection)
      .replace(/{thumbnail_section}/g, thumbnailSection);

    console.log(`[gemini-text] Analyzing ${ctx.videoId} with ${this.model} (basis: ${analysisBasis})${ctx.batch ? ' (BATCH)' : ''}...`);

    const result = await callModelText(template, userMessage, this.model,
      cover ? { images: [cover] } : undefined);

    const validated = VideoAnalysisDataSchema.safeParse(result.parsed);
    if (!validated.success) {
      console.error('[gemini-text] Schema validation errors:', validated.error?.issues);
      throw new Error(`Gemini text output failed schema validation: ${validated.error?.issues.map(i => i.message).join(', ')}`);
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
