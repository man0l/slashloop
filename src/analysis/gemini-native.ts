// ---------------------------------------------------------------------------
// Gemini Native Video Analyzer
// Uploads the video file to Gemini Files API, runs a single generateContent call.
// ~$0.001–0.002 per 30s video (gemini-2.5-flash-lite).
// Sees video + audio + on-screen text. No ffmpeg, no OCR, no Whisper needed.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoAnalysisDataSchema } from './schema.js';
import type { VideoAnalyzer, AnalysisContext, AnalysisOutput } from './types.js';
import { getCostCents } from './types.js';
import type { AnalysisConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '../../prompts/gemini-observe.v1.md');

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, 'utf-8');
}

function buildUserMessage(ctx: AnalysisContext, template: string): string {
  const followers = ctx.creatorFollowers?.toLocaleString() ?? 'unknown';
  const duration = ctx.durationSec ?? 'unknown';
  const outlierScore = ctx.outlierScore?.toFixed(1) ?? 'N/A';
  const outlierExplanation = ctx.outlierExplanation ?? 'no score yet';
  const shares = ctx.shares?.toLocaleString() ?? 'N/A';
  const saves = ctx.saves?.toLocaleString() ?? 'N/A';

  let transcriptSection = '\n- **Transcript**: *No transcript available.*';
  if (ctx.transcript && ctx.transcript.trim()) {
    transcriptSection = `\n- **Transcript**:\n\`\`\`\n${ctx.transcript}\n\`\`\``;
  }

  return template
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
    .replace(/{caption}/g, ctx.caption || '*No caption.*')
    .replace(/{transcript_section}/g, transcriptSection);
}

// ---- Gemini API helpers ----

async function uploadFileToGemini(filePath: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const fileBlob = new Blob([readFileSync(filePath)], { type: mimeType });
  const formData = new FormData();
  formData.append('file', fileBlob, 'video.mp4');

  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    { method: 'POST', body: formData },
  );

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Gemini upload failed (${uploadRes.status}): ${text}`);
  }

  const uploadData = (await uploadRes.json()) as { file: { name: string; uri: string } };
  const fileUri = uploadData.file.uri;
  const fileName = uploadData.file.name;

  // Poll until ACTIVE
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    );
    if (!statusRes.ok) continue;
    const statusData = (await statusRes.json()) as { state: string; error?: any };
    if (statusData.state === 'ACTIVE') return fileUri;
    if (statusData.state === 'FAILED') {
      throw new Error(`Gemini file processing failed: ${JSON.stringify(statusData.error)}`);
    }
  }

  throw new Error('Gemini file processing timed out after 60s');
}

async function deleteGeminiFile(fileName: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, {
      method: 'DELETE',
    });
  } catch { /* best effort */ }
}

async function callGeminiGenerate(
  model: string,
  fileUri: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{
          parts: [
            { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
            { text: userMessage },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
        },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini generateContent failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    throw new Error('Gemini returned no text content');
  }

  let raw = textContent.trim();
  if (raw.startsWith('```json')) raw = raw.slice(7);
  else if (raw.startsWith('```')) raw = raw.slice(3);
  if (raw.endsWith('```')) raw = raw.slice(0, -3);
  raw = raw.trim();

  try {
    return {
      parsed: JSON.parse(raw),
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch {
    throw new Error('Failed to parse Gemini response as JSON');
  }
}

// ---- Analyzer implementation ----

export class GeminiNativeAnalyzer implements VideoAnalyzer {
  readonly name = 'Gemini Native Video';
  readonly backendId = 'gemini-native';
  readonly provider = 'google';
  private model: string;

  constructor(config?: AnalysisConfig) {
    this.model = config?.geminiModel ?? 'gemini-3.5-flash';
  }

  async analyze(ctx: AnalysisContext): Promise<AnalysisOutput> {
    if (!ctx.videoFilePath) {
      throw new Error('Gemini native backend requires a video file path. Set ctx.videoFilePath.');
    }

    const template = loadPromptTemplate();
    const userMessage = buildUserMessage(ctx, template);

    // Upload video
    console.log(`[gemini-native] Uploading video for ${ctx.videoId}...`);
    const { fileUri, fileName } = await this.uploadWithFileName(ctx.videoFilePath);

    try {
      // Generate analysis
      console.log(`[gemini-native] Analyzing with ${this.model}...`);
      const result = await callGeminiGenerate(this.model, fileUri, template, userMessage);

      // Validate
      const validated = VideoAnalysisDataSchema.safeParse(result.parsed);
      if (!validated.success) {
        console.error('[gemini-native] Schema validation errors:', validated.error?.issues);
        throw new Error(`Gemini output failed schema validation: ${validated.error?.issues.map(i => i.message).join(', ')}`);
      }

      // Determine basis
      const hasTranscript = !!(ctx.transcript?.trim());
      const analysisBasis = hasTranscript ? 'video+transcript' : 'video';

      // Estimate cost (batch discount applies if ctx.batch)
      const costCents = getCostCents('gemini-native', this.model, ctx.batch ?? false) || 0.2;

      return {
        data: validated.data,
        analysisBasis,
        backend: this.backendId,
        model: this.model,
        costCents: Math.round(costCents * 100) / 100,
        provider: this.provider,
      };
    } finally {
      // Cleanup: delete the uploaded file
      await deleteGeminiFile(fileName).catch(() => {});
    }
  }

  private async uploadWithFileName(filePath: string): Promise<{ fileUri: string; fileName: string }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

    const fileBlob = new Blob([readFileSync(filePath)], { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('file', fileBlob, 'video.mp4');

    const uploadRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
      { method: 'POST', body: formData },
    );

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Gemini upload failed (${uploadRes.status}): ${text}`);
    }

    const uploadData = (await uploadRes.json()) as { file: { name: string; uri: string } };

    // Poll until ACTIVE
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statusRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${uploadData.file.name}?key=${apiKey}`,
      );
      if (!statusRes.ok) continue;
      const statusData = (await statusRes.json()) as { state: string };
      if (statusData.state === 'ACTIVE') {
        return { fileUri: uploadData.file.uri, fileName: uploadData.file.name };
      }
      if (statusData.state === 'FAILED') {
        throw new Error('Gemini file processing failed');
      }
    }

    throw new Error('Gemini file processing timed out');
  }
}