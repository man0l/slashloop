// GET /gallery?t=<signed token>                          — the outlier gallery
//     as a plain web page.
// GET /api/gallery-data?workspaceId=&sourceId=&sortBy=... — JSON cards for the
//     site's Gallery page (rewritten here with mode=data — see vercel.json).
// GET /api/gallery-data?workspaceId=&creatorHandle=...     — hover preview for
//     one creator (outliers + last 5 already in the workspace).
//
// The HTML route is a second delivery path for the exact HTML that
// `show_gallery` publishes as a `ui://` MCP App resource (src/tools/gallery.ts,
// docs/media-storage-plan.md §4). Same buildGalleryHtml() call, same cards,
// same client-side filters — the only difference is who renders it.
//
// This exists because MCP Apps are opt-in on the CLIENT: a host renders a
// `ui://` resource only if it declared `io.modelcontextprotocol/ui` during
// initialize. Claude Cowork and other Claude Code / Agent SDK hosts do not, so
// `_meta.ui.resourceUri` is dropped silently and the user sees a JSON summary
// where a gallery should be. A URL works in every host, because it is not the
// host's job to render it.
//
// Auth (HTML route): a narrow, short-lived, audience-pinned token minted
// during the tool call (src/lib/gallery-link.ts). It authorises exactly one
// thing — render this user's gallery — and cannot be replayed against /mcp.
// The workspace is derived from the token's `sub` via runWithUser →
// requireWorkspace, identical to the MCP path, so query params can never
// widen what is visible.
//
// Auth (JSON route): Supabase Bearer JWT + an explicit workspaceId the caller
// must own or be a team member of (requireWorkspaceAccess) — see src/lib/authz.ts.
//
// The two routes share this one file rather than living in api/gallery.ts and
// api/gallery-data.ts separately: the Hobby plan caps a deployment at 12
// Serverless Functions (see api/sources.ts for the same constraint).

import { runWithUser } from '../src/context.js';
import { requireWorkspace } from '../src/context.js';
import { buildGalleryHtml, buildCards } from '../src/tools/gallery.js';
import { buildCreatorPreview } from '../src/lib/creator-preview.js';
import { verifyGalleryToken, isGalleryLinkEnabled } from '../src/lib/gallery-link.js';
import { corsPreflight } from '../src/lib/cors.js';
import { requireWorkspaceAccess, jsonResponse } from '../src/lib/authz.js';
import { createExperiment, estimate } from '../src/experiments/service.js';
import { ExperimentError } from '../src/experiments/schema.js';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod/v4';
import type { GalleryFilters } from '../src/ui/gallery.js';

/**
 * Deny-by-default CSP, mirroring what the MCP App declares via
 * `_meta.ui.csp.resourceDomains` (§4.1). The page is self-contained — inline
 * CSS and inline JS — so the only remote origins needed are the ones the
 * direct-URL rendering actually points at (stored thumb public base, the
 * Worker's /thumbs and /media routes), for `img-src` and `media-src`.
 *
 * `'unsafe-inline'` on script-src is required by that self-contained design and
 * is the same trade the sandboxed-iframe version already makes; there is no
 * user-controlled HTML in the document (every field goes through esc() in
 * src/ui/gallery.ts).
 */
function csp(domains: string[]): string {
  const media = [...domains, 'data:', 'blob:'].join(' ');
  return [
    "default-src 'none'",
    `img-src ${media}`,
    `media-src ${media}`,
    // The experiment survey POSTs its answers back to this same URL.
    "connect-src 'self'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function page(status: number, title: string, message: string): Response {
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — slashloop</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .box { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.1rem; margin:0 0 .5rem; }
  p { margin:0; opacity:.7; }
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Never let a shared cache hold an auth-gated page.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function num(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function densityOf(raw: string | null) {
  return raw === 'large' || raw === 'medium' || raw === 'small' || raw === 'list' ? raw : undefined;
}

/** Friendly "Analyzed by" keys accepted by both routes ('' / absent = any). */
const ANALYZED_BY_VALUES = new Set<GalleryFilters['analyzedBy']>(['openrouter']);

function analyzedByOf(raw: string | null): GalleryFilters['analyzedBy'] | undefined {
  return raw && (ANALYZED_BY_VALUES.has(raw as GalleryFilters['analyzedBy']))
    ? (raw as GalleryFilters['analyzedBy'])
    : undefined;
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

/**
 * POST /gallery?t=<signed token> — create a draft experiment from the
 * in-page survey (selection + edit/create steps). Same trust model as the
 * HTML route: the short-lived gallery token authorises exactly this user's
 * gallery, and the workspace is resolved server-side from the token holder —
 * the client can never widen what is visible or bill another workspace.
 * Creates a DRAFT only (no spend); planning/generating stays on the
 * experiment API. Returns the draft id plus the plan-stage estimate so the
 * survey can show the cost before anything is spent.
 */
async function readSurveyBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ExperimentError(400, 'body_required');
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > 128000) throw new ExperimentError(413, 'body_too_large');
      text += decoder.decode(r.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let value: unknown;
  try {
    value = JSON.parse(text + decoder.decode());
  } catch {
    throw new ExperimentError(400, 'invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExperimentError(400, 'invalid_body');
  return value as Record<string, unknown>;
}

export async function POST(request: Request): Promise<Response> {
  if (!isGalleryLinkEnabled()) return jsonResponse(500, { error: 'gallery links are not configured' }, request);
  const url = new URL(request.url);
  const userId = await verifyGalleryToken(url.searchParams.get('t'));
  if (!userId) return jsonResponse(401, { error: 'This gallery link has expired' }, request);
  try {
    const body = await readSurveyBody(request);
    const survey = (body.survey ?? body) as Record<string, unknown>;
    // surveyMode is a UI-only marker (edit vs create steps) — not part of Create.
    const { surveyMode: _mode, ...fields } = survey;
    const created = await runWithUser(userId, async () => {
      const workspace = await requireWorkspace();
      return createExperiment({ ...fields, workspaceId: workspace.id, idempotencyKey: randomUUID() });
    });
    const plan = await estimate(created, 'plan');
    return jsonResponse(200, {
      experiment: { id: created.id, status: created.status, slideCount: created.slideCount },
      estimate: { plan },
    }, request);
  } catch (err) {
    if (err instanceof ExperimentError) return jsonResponse(err.statusCode, { error: err.code, message: err.message }, request);
    if (err instanceof ZodError) {
      return jsonResponse(422, { error: 'invalid_survey', message: err.issues[0]?.message ?? 'invalid survey' }, request);
    }
    console.error('[gallery] experiment survey failed:', (err as Error).message);
    return jsonResponse(500, { error: 'survey_failed' }, request);
  }
}

const SORT_VALUES = new Set<GalleryFilters['sortBy']>(['outlier_score', 'views', 'newest']);

async function handleData(request: Request, url: URL): Promise<Response> {
  const auth = await requireWorkspaceAccess(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  // Hover preview on the site's Gallery — already-scraped outliers + last 5
  // for one creator, no live scrape. Distinct response shape (outliers/recent,
  // no `cards`) so an older connector that ignored this param is detectable.
  const creatorHandle = url.searchParams.get('creatorHandle');
  if (creatorHandle) {
    const preview = await buildCreatorPreview(auth.workspace, creatorHandle);
    return jsonResponse(200, preview, request);
  }

  const sortByRaw = url.searchParams.get('sortBy') ?? 'outlier_score';
  const sortBy = SORT_VALUES.has(sortByRaw as GalleryFilters['sortBy'])
    ? (sortByRaw as GalleryFilters['sortBy'])
    : 'outlier_score';

  const limitRaw = Number(url.searchParams.get('limit') ?? '');
  const minOutlierRaw = Number(url.searchParams.get('minOutlier') ?? '');
  const minViewsRaw = Number(url.searchParams.get('minViews') ?? '');

  // buildCards() resolves its workspace through requireWorkspace(), which
  // reads the current user id from AsyncLocalStorage (the MCP-tool context
  // primitive, see src/context.ts) — run this REST handler inside that same
  // context rather than re-deriving workspace resolution here. The email
  // rides along so team members (email-keyed invites) resolve shared
  // workspaces instead of throwing.
  const { cards, note, filters } = await runWithUser(auth.userId, () =>
    buildCards({
      workspaceId: auth.workspace.id,
      sourceId: url.searchParams.get('sourceId') ?? undefined,
      videoId: url.searchParams.get('videoId') ?? undefined,
      sortBy,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      minOutlier: Number.isFinite(minOutlierRaw) && minOutlierRaw > 0 ? minOutlierRaw : undefined,
      minViews: Number.isFinite(minViewsRaw) && minViewsRaw > 0 ? minViewsRaw : undefined,
      analyzedBy: analyzedByOf(url.searchParams.get('analyzedBy')),
    }),
    auth.email ?? undefined,
  );

  return jsonResponse(200, { cards, note, filters }, request);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('mode') === 'data') return handleData(request, url);

  if (!isGalleryLinkEnabled()) {
    return page(
      500,
      'Gallery links are not configured',
      'This deployment has no GALLERY_LINK_SECRET (or SUPABASE_SECRET_KEY / CRON_SECRET) set, so gallery links cannot be verified.',
    );
  }

  const userId = await verifyGalleryToken(url.searchParams.get('t'));
  if (!userId) {
    return page(
      401,
      'This gallery link has expired',
      'Gallery links are short-lived. Ask for your outliers again in Claude to get a fresh one.',
    );
  }

  try {
    // Same context binding as the MCP path, so requireWorkspace() resolves the
    // token holder's workspace and nothing else.
    const { html, resourceDomains } = await runWithUser(userId, () =>
      buildGalleryHtml({
        sourceId: url.searchParams.get('sourceId') ?? undefined,
        minOutlier: num(url.searchParams.get('minOutlier')),
        minViews: num(url.searchParams.get('minViews')),
        analyzedBy: analyzedByOf(url.searchParams.get('analyzedBy')),
        density: densityOf(url.searchParams.get('density')),
      }),
    );

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp(resourceDomains),
        // The HTML embeds signed media URLs and is scoped to one user.
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('[gallery] render failed:', (err as Error).message);
    return page(
      500,
      'Could not load your gallery',
      'Something went wrong rendering the page. Try again in a moment.',
    );
  }
}
