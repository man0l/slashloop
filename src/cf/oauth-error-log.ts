// Log-level policy for OAuthProvider error responses. Kept free of provider
// imports (which pull in `cloudflare:workers`) so it is unit-testable under bun.

export type OAuthErrorEvent = {
  status: number;
  code: string;
  description: string;
  request?: Request;
};

export type OAuthErrorLevel = 'info' | 'warn' | 'error';

// Routine client-side failures: stale/revoked bearer tokens, malformed JSON,
// bad dynamic-registration metadata (incl. external probes).
const EXPECTED: Record<number, readonly string[]> = {
  401: ['invalid_token'],
  400: ['invalid_request', 'invalid_client_metadata'],
};

export function classifyOAuthError(e: Pick<OAuthErrorEvent, 'status' | 'code'>): OAuthErrorLevel {
  if (e.status >= 500) return 'error';
  return EXPECTED[e.status]?.includes(e.code) ? 'info' : 'warn';
}

// Descriptions can echo client-supplied strings (e.g. a probe's grant type),
// so strip control chars and cap the length. Tokens and bodies are never read.
function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export function formatOAuthError(e: OAuthErrorEvent): string {
  const ua = e.request?.headers.get('user-agent');
  return `OAuth error response: ${e.status} ${clean(e.code, 64)} - ${clean(e.description, 200)}${
    ua ? ` ua=${clean(ua, 120)}` : ''
  }`;
}

// Returns void so the provider keeps its normal error response; only the log
// level changes (the provider's default handler always warned).
export function logOAuthError(e: OAuthErrorEvent): void {
  console[classifyOAuthError(e)](formatOAuthError(e));
}
