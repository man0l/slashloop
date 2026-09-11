// Worker request router — mirrors vercel.json's rewrites 1:1.
//
// Vercel's `src → dest + query injection` table becomes a regex list that
// rewrites the incoming URL and dispatches by HTTP method to the SAME
// handler modules (api/*.ts export per-method Web-standard handlers, e.g.
// `export async function POST(request: Request)`), so the migration moves
// hosting without touching handler logic. Exception: /mcp is served by the
// Cloudflare-native module (./mcp.ts — createMcpHandler, no transport
// boilerplate); api/mcp.ts remains the Vercel path. Order matters exactly like it did
// in vercel.json: specific actions before generic `/:id` captures.

import * as mcp from './mcp.js';
import * as gallery from '../../api/gallery.js';
import * as sources from '../../api/sources.js';
import * as videos from '../../api/videos.js';
import * as workspaces from '../../api/workspaces.js';
import * as billing from '../../api/billing.js';
import * as digestSettings from '../../api/digest-settings.js';
import * as stripeWebhook from '../../api/stripe/webhook.js';
import * as jobsAnalyze from '../../api/jobs/analyze.js';
import * as cronDigest from '../../api/cron/digest.js';
import * as cronRetention from '../../api/cron/media-retention.js';
import * as internalRawBatch from './internal.js';
import * as mediaRoutes from './media-routes.js';
import { loginPage, legacyLoginPage, consentPage } from '../../remote/pages.js';
import { AUTHORIZATION_SERVER } from '../../remote/mcp-server.js';
import { corsHeaders } from '../lib/cors.js';

type HandlerModule = Record<string, unknown>;

interface Route {
  re: RegExp;
  mod?: HandlerModule;
  /** Static query params injected before dispatch (vercel.json dest params). */
  inject?: Record<string, string>;
  /** Non-module handlers (the pages set, re-implemented below). */
  page?: 'well-known' | 'login' | 'legacy-login' | 'consent' | 'health' | '404';
}

/** PUBLIC_URL wins, else the request origin — same rule as api/mcp.ts. */
function originOf(url: URL): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `${url.protocol}//${url.host}`;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// The pages set — Web-standard ports of remote/handlers.ts handle* (the Node
// versions stay for remote/dev.ts; api/pages.ts is the Vercel wrapper).
function servePage(page: NonNullable<Route['page']>, url: URL): Response {
  const origin = originOf(url);
  switch (page) {
    case 'well-known':
      // RFC 9728 protected-resource metadata. The OAuthProvider owns this
      // endpoint in production (it also serves authorization-server metadata at
      // /.well-known/oauth-authorization-server); this static body is the
      // dual-accept fallback used by defaultHandler/local paths. Final
      // discovery shape post-merge:
      //   { "resource": "<origin>/mcp",
      //     "authorization_servers": ["<as-issuer>"],
      //     "scopes_supported": [...], "bearer_methods_supported": ["header"],
      //     "resource_name": "slashloop" }
      // (the migrate agent flips AUTHORIZATION_SERVER off Supabase /auth/v1).
      return jsonResponse({ resource: `${origin}/mcp`, authorization_servers: [AUTHORIZATION_SERVER] });
    case 'login':
      // Primary login is the Supabase widget while Supabase JWTs are
      // accepted. With ACCEPT_SUPABASE_JWT=0 /login degrades to the native
      // Google login (never a 404).
      if ((process.env.ACCEPT_SUPABASE_JWT ?? '') === '0') return htmlResponse(loginPage());
      return htmlResponse(legacyLoginPage());
    case 'legacy-login':
      // Pre-cutover test path for the native Google login. (Supabase is the
      // primary at /login until the flag flips; then the two swap roles.)
      return htmlResponse(loginPage());
    case 'consent':
      return htmlResponse(consentPage());
    case '404':
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    case 'health':
    default:
      return jsonResponse({
        ok: true,
        service: 'slashloop',
        mode: 'remote',
        public_url: origin,
        as: AUTHORIZATION_SERVER,
        tools: 'full',
        db: 'parallel',
      });
  }
}

// Ordered exactly like vercel.json's routes array.
const ROUTES: Route[] = [
  { re: /^\/mcp$/, mod: mcp },
  { re: /^\/\.well-known\/oauth-protected-resource$/, page: 'well-known' },
  // OAuthProvider authorize endpoint (advertised in its metadata, served by
  // the defaultHandler): Phase 1 reuses the Supabase login page. Completing
  // the provider browser flow (parseAuthRequest → approve → grant) is later.
  { re: /^\/authorize$/, page: 'login' },
  { re: /^\/oauth\/consent$/, page: 'consent' },
  { re: /^\/login$/, page: 'login' },
  // Native Google login test path. Its <details> fallback links back to
  // /login (Supabase, the primary). See servePage 'login'/'legacy-login'.
  { re: /^\/login\/legacy$/, page: 'legacy-login' },
  // NOTE: /authorize and /oauth/google/callback never reach this router —
  // the OAuthProvider defaultHandler wrapper in src/cf/oauth.ts intercepts
  // both first (Google redirect + code exchange). The /authorize page entry
  // below is shadowed for the same reason; both stay as documentation.
  { re: /^\/health$/, page: 'health' },
  { re: /^\/gallery$/, mod: gallery },
  { re: /^\/api\/gallery-data$/, mod: gallery, inject: { mode: 'data' } },
  { re: /^\/api\/billing(?:\/([^/]+?))?$/, mod: billing, inject: { action: '$1' } },
  // sources — specific actions before the generic /:id capture.
  { re: /^\/api\/sources\/suggest\/verify$/, mod: sources, inject: { action: 'suggest-verify' } },
  { re: /^\/api\/sources\/suggest\/dismiss$/, mod: sources, inject: { action: 'suggest-dismiss' } },
  { re: /^\/api\/sources\/discover\/mine$/, mod: sources, inject: { action: 'discover-mine' } },
  { re: /^\/api\/sources\/discover$/, mod: sources, inject: { action: 'discover' } },
  { re: /^\/api\/sources\/suggest$/, mod: sources, inject: { action: 'suggest' } },
  { re: /^\/api\/sources$/, mod: sources },
  { re: /^\/api\/sources(?:\/([^/]+?))\/refresh$/, mod: sources, inject: { id: '$1', action: 'refresh' } },
  { re: /^\/api\/sources(?:\/([^/]+?))$/, mod: sources, inject: { id: '$1' } },
  // workspaces / studio.
  { re: /^\/api\/studio\/retro$/, mod: workspaces, inject: { resource: 'retro' } },
  { re: /^\/api\/studio\/benchmark$/, mod: workspaces, inject: { resource: 'benchmark' } },
  { re: /^\/api\/workspaces$/, mod: workspaces },
  { re: /^\/api\/workspaces(?:\/([^/]+?))$/, mod: workspaces, inject: { id: '$1' } },
  // videos + hook tests.
  { re: /^\/api\/videos(?:\/([^/]+?))\/analyze$/, mod: videos, inject: { id: '$1', action: 'analyze' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/fetch$/, mod: videos, inject: { id: '$1', action: 'fetch' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/hook-test\/pick$/, mod: videos, inject: { id: '$1', action: 'hook-test-pick' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/hook-test\/reroll$/, mod: videos, inject: { id: '$1', action: 'hook-test-reroll' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/hook-test\/close$/, mod: videos, inject: { id: '$1', action: 'hook-test-close' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/hook-test\/shotlist$/, mod: videos, inject: { id: '$1', action: 'hook-test-shotlist' } },
  { re: /^\/api\/videos(?:\/([^/]+?))\/hook-test$/, mod: videos, inject: { id: '$1', action: 'hook-test' } },
  { re: /^\/api\/videos(?:\/([^/]+?))$/, mod: videos, inject: { id: '$1' } },
  // crons / internals.
  { re: /^\/api\/cron\/media-retention$/, mod: cronRetention },
  { re: /^\/api\/cron\/digest$/, mod: cronDigest },
  { re: /^\/api\/digest-settings$/, mod: digestSettings },
  { re: /^\/api\/jobs\/analyze$/, mod: jobsAnalyze },
  { re: /^\/api\/stripe\/webhook$/, mod: stripeWebhook },
  // VPS-side atomic batch bridge (src/cf/internal.ts) — before the catch-all.
  { re: /^\/internal\/raw-batch$/, mod: internalRawBatch },
  // Binding-backed media (src/cf/media-routes.ts) — Workers-only routes.
  { re: /^\/thumbs\/.+$/, mod: mediaRoutes },
  { re: /^\/media\/.+$/, mod: mediaRoutes },
  { re: /^\/$/, page: 'health' },
  { re: /.*/, page: '404' },
];

async function dispatch(mod: HandlerModule, method: string, request: Request): Promise<Response> {
  const effective = method === 'HEAD' ? 'GET' : method;
  const handler = mod[effective];
  if (typeof handler !== 'function') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).join(', ') },
    });
  }
  // Never let a handler throw past the runtime: an uncaught throw becomes a
  // bare 500 with no CORS headers, which browsers misreport as a CORS
  // failure and the site renders as a hang with no Retry. Log it and answer
  // JSON with CORS so every failure is visible and retryable.
  try {
    return await (handler as (req: Request) => Promise<Response> | Response)(request);
  } catch (err) {
    const busy = (err as { name?: string }).name === 'DbBusyError';
    console.error(
      `[router] ${effective} ${new URL(request.url).pathname} threw: ${(err as Error).message}`,
    );
    return new Response(
      JSON.stringify({ error: busy ? 'isolate_busy' : 'internal_error' }),
      {
        status: busy ? 503 : 500,
        headers: {
          'Content-Type': 'application/json',
          ...(busy ? { 'Retry-After': '1' } : {}),
          ...corsHeaders(request),
        },
      },
    );
  }
}

/** Route one request. Returns undefined only for internal upgrade paths (none today). */
export async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  for (const entry of ROUTES) {
    const match = entry.re.exec(url.pathname);
    if (!match) continue;

    if (entry.page) return servePage(entry.page, url);

    const mod = entry.mod!;
    if (entry.inject) {
      for (const [key, value] of Object.entries(entry.inject)) {
        // $N refers to the corresponding regex capture group. An optional
        // group that didn't participate (e.g. bare /api/billing with no
        // /<action> segment) must NOT clobber an ?action= the caller already
        // set — Vercel's rewrite only fires with the segment present, so the
        // bare path keeps its own query string there too.
        const resolved = value.startsWith('$') ? (match[Number(value.slice(1))] ?? '') : value;
        if (value.startsWith('$') && !resolved) continue;
        url.searchParams.set(key, resolved);
      }
      request = new Request(url.toString(), request);
    }
    return dispatch(mod, request.method, request);
  }
  return servePage('404', url); // unreachable — the last route matches everything
}
