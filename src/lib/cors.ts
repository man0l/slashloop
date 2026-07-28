// ---------------------------------------------------------------------------
// CORS for the billing routes only (api/billing/*, not /mcp — an MCP client
// isn't a browser and doesn't send preflight). Fails closed: no SITE_URL
// configured means no CORS headers at all, so a browser blocks the request
// rather than defaulting to a permissive "*" on endpoints that read Bearer
// tokens.
// ---------------------------------------------------------------------------

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

export function corsHeaders(): Record<string, string> {
  if (!SITE_URL) return {};
  return {
    'Access-Control-Allow-Origin': SITE_URL,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
