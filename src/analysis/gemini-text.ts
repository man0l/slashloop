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
import { callGeminiText } from '../lib/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '../../prompts/gemini-text.v1.md');

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, 'utf-8');
}

function determineBasis(ctx: AnalysisContext): string {
  const hasTranscript = !!(ctx.transcript?.trim());
  const hasThumbnail = !!(ctx.thumbnailUrl?.trim());
  const hasCaption = !!(ctx.caption?.trim());

  if (hasTranscript && hasThumbnail) return 'transcript+thumbnail';
  if (hasTranscript) return 'transcript-only';
  if (hasThumbnail && hasCaption) return 'thumbnail+caption';
  return 'caption+metadata-only';
}

function basisDescription(basis: string): string {
  const map: Record<string, string> = {
    'transcript+thumbnail': 'You have a full transcript AND a thumbnail image URL. High confidence on verbal content; medium confidence on visual techniques.',
    'transcript-only': 'You have a full transcript but no thumbnail. High confidence on verbal content; lower confidence on visuals.',
    'thumbnail+caption': 'You have a thumbnail URL and caption but NO transcript. Medium confidence. Do NOT make claims about spoken content.',
    'caption+metadata-only': 'You have only the caption and engagement metadata. Lowest confidence. Focus on metadata signals. Do NOT make claims about visual or audio content.',
  };
  return map[basis] ?? 'Unknown basis';
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
    const analysisBasis = determineBasis(ctx);

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

    let thumbnailSection = '';
    if (ctx.thumbnailUrl?.trim()) {
      thumbnailSection = `\n- **Thumbnail URL**: ${ctx.thumbnailUrl}`;
    }

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

    const result = await callGeminiText(template, userMessage, this.model);

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
      provider: this.provider,
    };
  }
}
