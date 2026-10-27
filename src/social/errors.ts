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
  // Raw platform status + body (truncated) for server logs only — never shown
  // to the user. Carries the platform's error code/subcode/trace id, which the
  // human-readable message drops.
  detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'BadBodyError';
    this.detail = detail;
  }
}

/**
 * Why an OAuth connect failed, as a fixed code the OAuth callback can put in
 * the redirect URL (never raw platform text — the site maps each code to its
 * own copy). Undefined = no specific reason; the site shows its generic error.
 *
 * - `denied`: the user cancelled or refused the consent screen.
 * - `no_role`: sign-in worked but Meta refused the account's data — the app's
 *   permissions are at Standard access and this account has no accepted role
 *   (tester/admin) on the app. Meta reports it as error code 100
 *   "Unsupported request" on the first GET after the code exchange.
 * - `app_config`: the code exchange itself was rejected — app id/secret or
 *   redirect URL mismatch.
 */
export type ConnectFailureReason = 'denied' | 'no_role' | 'app_config';

export function connectFailureReason(err: unknown): ConnectFailureReason | undefined {
  if (!(err instanceof Error)) return undefined;
  const detail = (err as { detail?: string }).detail ?? '';
  if (err.message.startsWith('code exchange:')) return 'app_config';
  if (/Unsupported (get )?request/i.test(err.message) || /"code":\s*100\b/.test(detail)) return 'no_role';
  return undefined;
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
