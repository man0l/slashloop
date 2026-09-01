// ---------------------------------------------------------------------------
// CORS for the site-facing JSON API (api/billing/*, api/workspaces/*,
// api/sources/*, api/gallery-data.ts — not /mcp, an MCP client isn't a
// browser and doesn't send preflight). Fails closed: no SITE_URL configured
// means no CORS headers at all, so a browser blocks the request rather than
// defaulting to a permissive "*" on endpoints that read Bearer tokens.
// ---------------------------------------------------------------------------

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

const SECONDARY_SITE_URL = (process.env.SECONDARY_SITE_URL ?? '').replace(/\/$/, '');

/** Live app origin. slashloop.app is a retired host (no DNS since the .dev cutover). */
export const CANONICAL_SITE_URL = 'https://slashloop.dev';

const RETIRED_SITE_URLS = new Set(['https://slashloop.app', 'http://slashloop.app']);

const ALLOWED_ORIGINS = new Set(
  [SITE_URL, SECONDARY_SITE_URL, CANONICAL_SITE_URL, 'https://www.slashloop.dev']
    .filter((u) => Boolean(u) && !RETIRED_SITE_URLS.has(u)),
);

/** SITE_URL env, unless it still points at the retired .app host. */
export function canonicalSiteUrl(): string {
  if (SITE_URL && !RETIRED_SITE_URLS.has(SITE_URL)) return SITE_URL;
  if (SECONDARY_SITE_URL && !RETIRED_SITE_URLS.has(SECONDARY_SITE_URL)) return SECONDARY_SITE_URL;
  return CANONICAL_SITE_URL;
}

/**
 * Origin to send a browser back to (Stripe success/cancel/portal). Prefer the
 * request Origin when it is on the allowlist so a slashloop.dev checkout does
 * not land on a dead SITE_URL.
 */
export function siteUrlForRequest(request?: Request): string {
  const origin = request?.headers.get('origin')?.replace(/\/$/, '');
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return canonicalSiteUrl();
}

export function corsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };
  }
  if (ALLOWED_ORIGINS.size > 0 && !origin) {
    // Non-browser / direct tool call — echo the primary site.
    const primary = canonicalSiteUrl();
    return {
      'Access-Control-Allow-Origin': primary,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };
  }
  return {};
}

export function corsPreflight(request?: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
