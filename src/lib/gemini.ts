// ---------------------------------------------------------------------------
// Gemini API Client — text-only mode (no video upload).
// Used by GeminiTextAnalyzer as the fallback when GeminiNativeAnalyzer
// can't run (e.g. video too large, upload timeout, Apify download failure).
//
// Same model, same prompt format, just no `file_data` part — Gemini reads
// the transcript + caption + thumbnail URL as text. Cost is much lower than
// native video (~$0.0005–0.001 per call on Flash-Lite).
//
// Also used by the hook-variation generator and the brief generator.
// With this client, the whole slashloop pipeline runs on GEMINI_API_KEY
// alone — no other AI provider key is required.
// ---------------------------------------------------------------------------

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiTextCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function callGeminiText(
  systemPrompt: string,
  userMessage: string,
  model = 'gemini-3.5-flash',
  options?: GeminiTextCallOptions,
): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
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
