// ---------------------------------------------------------------------------
// LLM provider factory + adapters.
//
// The text-model surface (gemini-text analysis, hook variations, briefs,
// source suggestions) is an instance of the Adapter pattern behind a Factory:
//
//   TextModelClient  — the interface both providers implement
//   GoogleTextClient — adapter that talks to Google's Gemini API directly
//                      (wraps callGeminiText in src/lib/gemini.ts)
//   OpenRouterTextClient — adapter that talks to OpenRouter's OpenAI-compatible
//                      endpoint with the SAME Gemini model ids
//                      (src/lib/openrouter.ts)
//   createTextClient() — the factory: OpenRouter wins when OPENROUTER_API_KEY
//                      is set, otherwise Google.
//
// Callers use the facade callModelText() (or createTextClient()) and never
// know which provider served them. Switching providers is a deploy-time env
// change, not a code change — the point of the pattern.
//
// Video (gemini-native) is intentionally NOT routed through OpenRouter: it
// needs Google's Files API upload, which OpenRouter has no equivalent for. The
// existing fallback chain (native -> native fallback model -> text) degrades
// to this text surface when native fails, so a working OpenRouter key keeps
// the whole service producing analyses even with no Google quota.
// ---------------------------------------------------------------------------

import { callGeminiText, type GeminiTextCallOptions } from './gemini.js';
import { callOpenRouterText, type OpenRouterTextCallOptions } from './openrouter.js';

export type TextModelCallOptions = {
  maxTokens?: number;
  temperature?: number;
  images?: Array<{ mimeType: string; dataBase64: string }>;
};

export interface TextModelResult {
  parsed: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** The adapter contract — one method, two implementations. */
export interface TextModelClient {
  readonly provider: 'google' | 'openrouter';
  call(
    systemPrompt: string,
    userMessage: string,
    model: string,
    options?: TextModelCallOptions,
  ): Promise<TextModelResult>;
}

/** Adapter over Google's Gemini generateContent (the original client). */
class GoogleTextClient implements TextModelClient {
  readonly provider = 'google' as const;
  call(systemPrompt: string, userMessage: string, model: string, options?: TextModelCallOptions): Promise<TextModelResult> {
    return callGeminiText(systemPrompt, userMessage, model, options as GeminiTextCallOptions | undefined);
  }
}

/** Adapter over OpenRouter's OpenAI-compatible chat/completions. */
class OpenRouterTextClient implements TextModelClient {
  readonly provider = 'openrouter' as const;
  call(systemPrompt: string, userMessage: string, model: string, options?: TextModelCallOptions): Promise<TextModelResult> {
    return callOpenRouterText(systemPrompt, userMessage, model, options as OpenRouterTextCallOptions | undefined);
  }
}

/**
 * The factory. Provider is an env decision, not per-call:
 *   OPENROUTER_API_KEY set  -> OpenRouter (same Gemini models, no Google quota)
 *   otherwise               -> Google directly
 */
export function createTextClient(): TextModelClient {
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterTextClient();
  return new GoogleTextClient();
}

/** Which provider the factory would pick right now (for labels/usage logs). */
export function activeProvider(): 'google' | 'openrouter' {
  return createTextClient().provider;
}

/** Facade: call the active provider, same signature as callGeminiText. */
export function callModelText(
  systemPrompt: string,
  userMessage: string,
  model = 'gemini-3.5-flash',
  options?: TextModelCallOptions,
): Promise<TextModelResult> {
  return createTextClient().call(systemPrompt, userMessage, model, options);
}

export { modelToOpenRouter } from './openrouter.js';
