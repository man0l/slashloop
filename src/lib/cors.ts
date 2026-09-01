// ---------------------------------------------------------------------------
// CORS for the site-facing JSON API (api/billing/*, api/workspaces/*,
// api/sources/*, api/gallery-data.ts — not /mcp, an MCP client isn't a
// browser and doesn't send preflight). Fails closed: no SITE_URL configured
// means no CORS headers at all, so a browser blocks the request rather than
// defaulting to a permissive "*" on endpoints that read Bearer tokens.
// ---------------------------------------------------------------------------

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

const SECONDARY_SITE_URL = (process.env.SECONDARY_SITE_URL ?? '').replace(/\/$/, '');

const ALLOWED_ORIGINS = new Set(
  [SITE_URL, SECONDARY_SITE_URL, 'https://slashloop.dev', 'https://www.slashloop.dev']
    .filter(Boolean),
);

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
    const primary = SITE_URL || SECONDARY_SITE_URL || 'https://slashloop.dev';
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
