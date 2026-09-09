// ---------------------------------------------------------------------------
// CORS for the site-facing JSON API (api/billing/*, api/workspaces/*,
// api/sources/*, api/gallery-data.ts — not /mcp, an MCP client isn't a
// browser and doesn't send preflight). Fails closed: no SITE_URL configured
// means no CORS headers at all, so a browser blocks the request rather than
// defaulting to a permissive "*" on endpoints that read Bearer tokens.
// ---------------------------------------------------------------------------

// Read per call, not at module load: on Workers env vars are copied into
// process.env per-isolate by src/cf/env.ts AFTER imports run, so import-time
// reads would freeze an empty allowlist (failing closed on every billing
// request) even with SITE_URL set.
function siteUrlEnv(): string {
  return (process.env.SITE_URL ?? '').replace(/\/$/, '');
}

function secondarySiteUrlEnv(): string {
  return (process.env.SECONDARY_SITE_URL ?? '').replace(/\/$/, '');
}

/** Live app origin. slashloop.app is a retired host (no DNS since the .dev cutover). */
export const CANONICAL_SITE_URL = 'https://slashloop.dev';

const RETIRED_SITE_URLS = new Set(['https://slashloop.app', 'http://slashloop.app']);

function allowedOrigins(): Set<string> {
  const siteUrl = siteUrlEnv();
  const secondary = secondarySiteUrlEnv();
  return new Set(
    [siteUrl, secondary, CANONICAL_SITE_URL, 'https://www.slashloop.dev']
      .filter((u) => Boolean(u) && !RETIRED_SITE_URLS.has(u)),
  );
}

/** SITE_URL env, unless it still points at the retired .app host. */
export function canonicalSiteUrl(): string {
  const siteUrl = siteUrlEnv();
  const secondary = secondarySiteUrlEnv();
  if (siteUrl && !RETIRED_SITE_URLS.has(siteUrl)) return siteUrl;
  if (secondary && !RETIRED_SITE_URLS.has(secondary)) return secondary;
  return CANONICAL_SITE_URL;
}

/**
 * Origin to send a browser back to (Stripe success/cancel/portal). Prefer the
 * request Origin when it is on the allowlist so a slashloop.dev checkout does
 * not land on a dead SITE_URL.
 */
export function siteUrlForRequest(request?: Request): string {
  const allowed = allowedOrigins();
  const origin = request?.headers.get('origin')?.replace(/\/$/, '');
  if (origin && allowed.has(origin)) return origin;
  return canonicalSiteUrl();
}

export function corsHeaders(request?: Request): Record<string, string> {
  const allowed = allowedOrigins();
  const origin = request?.headers.get('origin');
  if (origin && allowed.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };
  }
  if (allowed.size > 0 && !origin) {
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
