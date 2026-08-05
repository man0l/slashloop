// ---------------------------------------------------------------------------
// Gemini error classification — turn a paid, quota-bounded API's failures into
// a stable category the rest of the system can act on.
//
// Why this exists: every slashloop analysis runs on GEMINI_API_KEY (gemini-
// native video upload and gemini-text fallback share the same key and the same
// Google quota). When that key runs out of credits — exactly the paid-API
// failure mode this module exists for — Google answers with HTTP 429 and a
// RESOURCE_EXHAUSTED body. But the Gemini clients in this repo throw a single
// string that embeds the status ("Gemini generateContent failed (429): ..."),
// and until now no caller ever looked inside that sentence. So:
//
//   - classifyGeminiError(err)      -> { category, retryable, message }
//   - errorCodeFor(category)        -> a stable token ('gemini_quota', ...)
//   - tagJobFailure(err)            -> "[gemini_quota] <original message>"
//   - parseJobLastError(lastError)  -> { errorCode, message } back out
//
// The "[code] message" tag is what lets a category survive the DB without a
// schema change: MediaJob.lastError and the REST surfaces are strings, so we
// round-trip the code through the tag instead of adding a column + migration
// (see video-service.ts / api/videos.ts for the consumers).
// ---------------------------------------------------------------------------

export type GeminiErrorCategory =
  | 'quota' // 429 RESOURCE_EXHAUSTED — the paid key's budget is spent
  | 'rate_limit' // 429 RATE_LIMIT_EXCEEDED — transient, slow down
  | 'auth' // 400/401/403 — missing/invalid/revoked API key
  | 'invalid_request' // 400 — malformed input, not fixed by a retry
  | 'server' // 5xx / 503 UNAVAILABLE — Google's fault, transient
  | 'timeout' // request/upload/processing timed out, usually transient
  | 'unknown';

export interface GeminiErrorInfo {
  category: GeminiErrorCategory;
  /** Whether retrying the same call is likely to succeed later. */
  retryable: boolean;
  /** The original thrown message (kept for diagnostics). */
  message: string;
}

/** Stable machine tokens — this is what ends up in the [tag] and in APIs. */
export const GEMINI_ERROR_CODES = {
  quota: 'gemini_quota',
  rate_limit: 'gemini_rate_limit',
  auth: 'gemini_auth',
  invalid_request: 'gemini_request',
  server: 'gemini_server',
  timeout: 'gemini_timeout',
  unknown: 'other',
} as const;

export type GeminiErrorCode = (typeof GEMINI_ERROR_CODES)[keyof typeof GEMINI_ERROR_CODES];

export function errorCodeFor(category: GeminiErrorCategory): GeminiErrorCode {
  return GEMINI_ERROR_CODES[category];
}

const KNOWN_CODES = new Set<string>(Object.values(GEMINI_ERROR_CODES));

/**
 * Does the error message carry a given HTTP status? The two Gemini clients
 * format differently — gemini-native uses "(429): ...", the text client
 * "error 429: ..." — so match the code with an optional paren and whatever
 * terminator it has. Bodies are JSON with quoted keys, so a bare 3-digit
 * value hitting `(:|))` is unlikely; this is classification, not a firewall.
 */
function hasStatus(message: string, code: number): boolean {
  return new RegExp(`\\(?${code}\\)?[:)]`).test(message);
}

/**
 * Classify a thrown error against the error messages the Gemini clients emit
 * (and the bodies embedded in them). Order matters: 429 is checked first
 * because it is the one status with two meanings, then auth, then 5xx.
 */
export function classifyGeminiError(err: unknown): GeminiErrorInfo {
  const message = err instanceof Error ? err.message : String(err);

  // 429: quota (RESOURCE_EXHAUSTED / "quota") vs transient rate limit. A bare
  // 429 with no qualifier defaults to quota — for a paid key that is the
  // common and the user-relevant reading.
  if (hasStatus(message, 429) || /too many requests/i.test(message)) {
    if (/\bRESOURCE_EXHAUSTED\b/i.test(message) || /\bquota\b/i.test(message)) {
      return { category: 'quota', retryable: true, message };
    }
    if (/\brate ?limit/i.test(message) || /\bRATE_LIMIT_EXCEEDED\b/i.test(message)) {
      return { category: 'rate_limit', retryable: true, message };
    }
    return { category: 'quota', retryable: true, message };
  }

  // OpenRouter's 402 "payment_required" (insufficient credits) is the same
  // paid-key budget signal as a Google quota error — the user's service should
  // present it as "credits ran out, come back later," not "analysis failed".
  if (/\bpayment_required\b/i.test(message) || /insufficient credit/i.test(message)) {
    return { category: 'quota', retryable: true, message };
  }

  if (hasStatus(message, 401) || hasStatus(message, 403)
    || /\bapi key\b/i.test(message) || /invalid key/i.test(message) || /unauthorized/i.test(message)) {
    return { category: 'auth', retryable: false, message };
  }

  if (hasStatus(message, 400) || /\bINVALID_ARGUMENT\b/i.test(message) || /\bUNSUPPORTED\b/i.test(message)) {
    return { category: 'invalid_request', retryable: false, message };
  }

  if (hasStatus(message, 500) || hasStatus(message, 502) || hasStatus(message, 503) || hasStatus(message, 504)
    || /\bUNAVAILABLE\b/i.test(message) || /internal server error/i.test(message)) {
    return { category: 'server', retryable: true, message };
  }

  if (/timed?\s*out/i.test(message) || /timeout/i.test(message)) {
    return { category: 'timeout', retryable: true, message };
  }

  return { category: 'unknown', retryable: false, message };
}

/**
 * Prefix a code onto a failure message for storage in MediaJob.lastError, e.g.
 * "[gemini_quota] Gemini generateContent failed (429): {...}". The worker and
 * the MCP tools never need to read these themselves — parseJobLastError does,
 * at the edge — but keeping the tag on the raw message preserves the full
 * original text for debugging rather than replacing it with a category name.
 */
export function tagJobFailure(err: unknown): string {
  const info = classifyGeminiError(err);
  return `[${errorCodeFor(info.category)}] ${info.message}`;
}

/** Invert tagJobFailure: pull the code back off a stored lastError. */
export function parseJobLastError(lastError: string | null): { errorCode: GeminiErrorCode; message: string } | null {
  if (!lastError) return null;
  const m = /^\[([a-z][a-z0-9_]*)\]/.exec(lastError);
  if (m && KNOWN_CODES.has(m[1])) {
    const rest = lastError.slice(m[0].length).trim();
    return { errorCode: m[1] as GeminiErrorCode, message: rest || lastError };
  }
  return { errorCode: 'other', message: lastError };
}

/** Human-friendly message per error code, for the REST surface / frontend. */
export const GEMINI_ERROR_CODE_LABELS: Record<GeminiErrorCode, string> = {
  gemini_quota: 'The Gemini API is out of credits or quota right now. You were not charged for this — tap Analyze again later.',
  gemini_rate_limit: 'Gemini is rate-limiting requests just now. Try again in a moment.',
  gemini_auth: 'The Gemini API key is invalid or missing. This needs a server-side fix.',
  gemini_request: 'Gemini rejected this request. Retrying won\'t help.',
  gemini_server: 'Gemini had a server-side error. Try again shortly.',
  gemini_timeout: 'The request to Gemini timed out. This is usually transient — try again.',
  other: 'Analysis failed.',
};

/** Friendly label for a code, falling back to the raw message for unknown ones. */
export function friendlyGeminiMessage(errorCode: GeminiErrorCode, detail?: string): string {
  const label = GEMINI_ERROR_CODE_LABELS[errorCode];
  if (!label || errorCode === 'other') return detail ?? label ?? 'Analysis failed.';
  return label;
}
