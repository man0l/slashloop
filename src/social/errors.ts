// Error triad the engine knows how to react to (Postiz's classification,
// distilled): refresh the token and retry, ask the user to reconnect, or fail
// the post with a human-readable message. Anything else is a transient error
// — the engine leaves the post in PROCESSING and resumes on a later tick.

export class RefreshTokenError extends Error {
  constructor(message = 'Access token expired or invalid') {
    super(message);
    this.name = 'RefreshTokenError';
  }
}

export class ReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconnectError';
  }
}

export class BadBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadBodyError';
  }
}

export type ErrorClassification = 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined;

/**
 * Match a platform error body against known substrings and classify it.
 * Per-provider `handleErrors` first; this is the shared fallback for status
 * codes every platform signals the same way.
 */
export function classifyHttpError(status: number, body: string): ErrorClassification {
  if (status === 429) return 'retry';
  if (status === 401) return 'refresh-token';
  if (status === 403) return 'bad-body';
  return status >= 500 ? 'retry' : undefined;
}
