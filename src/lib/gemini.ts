// ---------------------------------------------------------------------------
// Gemini API Client — text-only mode (no video upload).
// Used by GeminiTextAnalyzer as the fallback when GeminiNativeAnalyzer
// can't run (e.g. video too large, upload timeout, Apify download failure).
//
// Same model, same prompt format, just no `file_data` part — Gemini reads
// the transcript + caption + thumbnail URL as text. Cost is much lower than
// native video (~$0.0005–0.001 per call on Flash-Lite).
//
// Also used by the hook-variation generator, the brief generator, and the
// source-suggestion generator. With this client, the whole slashloop
// pipeline runs on GEMINI_API_KEY alone — no other AI provider key is
// required.
// ---------------------------------------------------------------------------

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** responseMimeType: 'application/json' constrains the output but is not a
 *  hard schema guarantee — the model occasionally still emits malformed or
 *  truncated JSON. One retry clears the vast majority of these; a second
 *  parse attempt against a substring extracted from the raw text catches
 *  the rest (extra prose the model added around an otherwise-valid body). */
const MAX_ATTEMPTS = 2;

export interface GeminiTextCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Images to send as real image parts, base64-encoded.
   *
   * Named "text" backend for what it lacks — video — not for what it may see.
   * Passing a cover here is the difference between the model looking at the
   * frame and being handed a URL string it cannot open.
   */
  images?: Array<{ mimeType: string; dataBase64: string }>;
}

interface RawGeminiResult {
  raw: string;
  finishReason: string | undefined;
  inputTokens: number;
  outputTokens: number;
}

async function requestGeminiOnce(
  systemPrompt: string,
  userMessage: string,
  model: string,
  options: GeminiTextCallOptions | undefined,
): Promise<RawGeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{
          parts: [
            // Images first: the model reads parts in order, and the prompt
            // refers to "the thumbnail" as something it can see.
            ...(options?.images ?? []).map(img => ({
              inline_data: { mime_type: img.mimeType, data: img.dataBase64 },
            })),
            { text: userMessage },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: options?.temperature ?? 0.3,
          maxOutputTokens: options?.maxTokens ?? 8192,
        },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini text API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned no content');

  let raw = content.trim();
  // Strip markdown fences if present
  if (raw.startsWith('```json')) raw = raw.slice(7);
  else if (raw.startsWith('```')) raw = raw.slice(3);
  if (raw.endsWith('```')) raw = raw.slice(0, -3);
  raw = raw.trim();

  return {
    raw,
    finishReason: data.candidates?.[0]?.finishReason,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/** The model occasionally wraps valid JSON in leftover prose despite JSON
 *  mode (e.g. "Here you go:\n[...]"). Slice from the first bracket to the
 *  matching-type last bracket and try again before giving up entirely. */
function extractJsonSubstring(raw: string): string | null {
  const firstArray = raw.indexOf('[');
  const firstObject = raw.indexOf('{');
  let start: number;
  let closeChar: string;
  if (firstArray !== -1 && (firstObject === -1 || firstArray < firstObject)) {
    start = firstArray;
    closeChar = ']';
  } else if (firstObject !== -1) {
    start = firstObject;
    closeChar = '}';
  } else {
    return null;
  }
  const end = raw.lastIndexOf(closeChar);
  if (end <= start) return null;
  return raw.slice(start, end + 1);
}

export async function callGeminiText(
  systemPrompt: string,
  userMessage: string,
  model = 'gemini-3.5-flash',
  options?: GeminiTextCallOptions,
): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number }> {
  let lastResult: RawGeminiResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await requestGeminiOnce(systemPrompt, userMessage, model, options);
    lastResult = result;

    for (const candidate of [result.raw, extractJsonSubstring(result.raw)]) {
      if (candidate === null) continue;
      try {
        return { parsed: JSON.parse(candidate), inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      } catch {
        // try the next candidate, or the next attempt
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[gemini] attempt ${attempt}/${MAX_ATTEMPTS} returned unparseable JSON `
        + `(finishReason=${result.finishReason ?? 'unknown'}) — retrying`);
    }
  }

  const truncated = lastResult?.finishReason === 'MAX_TOKENS'
    ? ' (response was truncated at the token limit)'
    : '';
  throw new Error(
    `Failed to parse Gemini response as JSON after ${MAX_ATTEMPTS} attempt(s)${truncated}: `
    + `${(lastResult?.raw ?? '').slice(0, 300)}`,
  );
}
