// ---------------------------------------------------------------------------
// OpenRouter adapter — routes the SAME Gemini model IDs through OpenRouter's
// OpenAI-compatible /chat/completions endpoint so the service keeps producing
// analyses when GEMINI_API_KEY is free-tier/quota'd (the 503/429 scenario we
// hit) or absent entirely.
//
// Scope: text-model surface only (gemini-text analysis, hook variations,
// briefs, source suggestions). Google's native video path needs the Files API
// upload, which OpenRouter has no equivalent for (base64 video parts are
// impractical at MP4 sizes), so gemini-native keeps using GEMINI_API_KEY and
// the existing fallback chain degrades to this text path on failure.
//
// OpenAI-compatible, so the request/response shape is flat JSON — no Google
// SDK. Selected by the factory in src/lib/llm.ts when OPENROUTER_API_KEY is
// set. Errors are classified into the same categories as Gemini errors
// (see classifyOpenRouterError) so the REST/worker error handling needs no
// provider-awareness.
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

export interface OpenRouterTextCallOptions {
  maxTokens?: number;
  temperature?: number;
  /** Cover images as real image parts (sent as base64 data URLs). */
  images?: Array<{ mimeType: string; dataBase64: string }>;
}

/** Map our internal Gemini model id -> OpenRouter's canonical model id. */
export function modelToOpenRouter(model: string): string {
  const map: Record<string, string> = {
    'gemini-3.5-flash': 'google/gemini-3.5-flash',
    'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
    'gemini-3.6-flash': 'google/gemini-3.6-flash',
    'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
    'gemini-2.5-flash': 'google/gemini-2.5-flash',
    'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
    'gemini-2.5-pro': 'google/gemini-2.5-pro',
  };
  if (map[model]) return map[model];
  // Already provider-qualified (google/..., qwen/..., z-ai/..., ...): pass through.
  if (model.includes('/')) return model;
  throw new Error(`No OpenRouter model mapping for "${model}"`);
}

/**
 * Build the `user` message content: plain text, or a rich content array with
 * the cover attached as an OpenAI-style image_url data-URL part. Pure so it
 * can be unit-tested without a network call.
 */
export function buildUserContent(
  userMessage: string,
  images?: Array<{ mimeType: string; dataBase64: string }>,
): string | Array<Record<string, unknown>> {
  if (!images?.length) return userMessage;
  return [
    { type: 'text', text: userMessage },
    ...images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
    })),
  ];
}

/**
 * Classify an OpenRouter failure into the same category vocabulary the rest of
 * the codebase uses (gemini-errors.ts). OpenRouter's envelope is
 * { error: { code, message, metadata: { error_type } } }, surfaced here inside
 * the thrown "OpenRouter API error <status>: <body>" message.
 */
export function classifyOpenRouterError(err: unknown): {
  category: 'quota' | 'rate_limit' | 'auth' | 'invalid_request' | 'server' | 'timeout' | 'unknown';
  retryable: boolean;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(/OpenRouter API error (\d{3})/.exec(message)?.[1] ?? 0);
  const errorType = /"error_type"\s*:\s*"([a-z_]+)"/.exec(message)?.[1];
  const bodyCode = Number(/"code"\s*:\s*(\d{3})/.exec(message)?.[1] ?? 0);
  const code = status || bodyCode;

  if (errorType === 'payment_required' || code === 402 || /insufficient credit/i.test(message)) {
    return { category: 'quota', retryable: true, message };
  }
  if (errorType === 'rate_limit_exceeded' || code === 429) {
    return { category: 'rate_limit', retryable: true, message };
  }
  if (errorType === 'authentication' || code === 401 || code === 403) {
    return { category: 'auth', retryable: false, message };
  }
  if (errorType === 'not_found' || code === 404) {
    return { category: 'invalid_request', retryable: false, message };
  }
  if (code >= 500 || errorType === 'provider_overloaded' || errorType === 'provider_unavailable'
    || errorType === 'server' || /timeout/i.test(message)) {
    return { category: 'server', retryable: true, message };
  }
  return { category: 'unknown', retryable: false, message };
}

export interface OpenRouterResult {
  parsed: unknown;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pull the first JSON object out of raw model text. Reasoning models
 * (qwen3.7, stepfun, glm-4.6v) emit a "Thinking process" preamble even in JSON
 * mode; code fences and prose can wrap the body. Finds the first '{' and
 * matches to the last '}', so the extreme carving above is unnecessary as long
 * as the wanted JSON is the first object. Returns null when nothing parses.
 */
export function extractFirstJson(text: string): unknown | null {
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  if (start === -1) return null;
  const end = fenced.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface OpenRouterVideoCallOptions {
  maxTokens?: number;
}

/**
 * How long to wait for an OpenRouter video chat completion before timing out.
 *
 * The job worker has a 60s Vercel timeout. With download+analysis now split
 * into separate fetch and analyze jobs, the analyze job has the full budget
 * for the AI call — no Apify download to subtract. 50s gives most models
 * enough time while leaving ~10s for the rest of the pipeline (reading stored
 * video, validating, persisting results).
 */
const OPENROUTER_VIDEO_TIMEOUT_MS = 50_000;

/**
 * One chat completion with a VIDEO part (URL or base64 data URL) against an
 * OpenRouter model that supports video input. Returns raw text + token counts;
 * the caller validates it against the analysis schema. JSON mode is requested
 * but providers vary in how strictly they honour it, so the caller should run
 * the output through extractFirstJson.
 */
export async function callOpenRouterVideo(
  systemPrompt: string,
  userText: string,
  model: string,
  videoUrl: string,
  options?: OpenRouterVideoCallOptions,
): Promise<{ rawText: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable is not set');

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(process.env.PUBLIC_URL ? { 'HTTP-Referer': process.env.PUBLIC_URL, 'X-Title': 'slashloop' } : {}),
    },
    signal: AbortSignal.timeout(OPENROUTER_VIDEO_TIMEOUT_MS),
    body: JSON.stringify({
      model: modelToOpenRouter(model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: userText },
          { type: 'video_url', video_url: { url: videoUrl } },
        ]},
      ],
      temperature: 0.3,
      // Reasoning models burn tokens on chain-of-thought; give them room to
      // still emit the full JSON (probed: max_tokens 200 starves them).
      max_tokens: options?.maxTokens ?? 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: number };
  };

  if (data.error) {
    throw new Error(`OpenRouter API error ${data.error.code ?? ''}: ${data.error.message ?? ''}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');

  return {
    rawText: content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

/**
 * One OpenAI-compatible chat completion against OpenRouter, requesting JSON.
 * Returns the parsed JSON plus token counts — same shape as callGeminiText, so
 * either provider drops into the same call sites.
 */
export async function callOpenRouterText(
  systemPrompt: string,
  userMessage: string,
  model = 'gemini-3.5-flash',
  options?: OpenRouterTextCallOptions,
): Promise<OpenRouterResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable is not set');

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // Attribution headers are optional but they feed the leaderboard.
      ...(process.env.PUBLIC_URL ? { 'HTTP-Referer': process.env.PUBLIC_URL, 'X-Title': 'slashloop' } : {}),
    },
    body: JSON.stringify({
      model: modelToOpenRouter(model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserContent(userMessage, options?.images) },
      ],
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 8192,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: number };
  };

  if (data.error) {
    throw new Error(`OpenRouter API error ${data.error.code ?? ''}: ${data.error.message ?? ''}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');

  let raw = content.trim();
  // Strip markdown fences if present.
  if (raw.startsWith('```json')) raw = raw.slice(7);
  else if (raw.startsWith('```')) raw = raw.slice(3);
  if (raw.endsWith('```')) raw = raw.slice(0, -3);
  raw = raw.trim();

  try {
    return {
      parsed: JSON.parse(raw),
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  } catch {
    throw new Error('Failed to parse OpenRouter response as JSON');
  }
}
