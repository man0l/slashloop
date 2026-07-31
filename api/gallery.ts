// GET /gallery?t=<signed token> — the outlier gallery as a plain web page.
//
// Second delivery route for the exact HTML that `show_gallery` publishes as a
// `ui://` MCP App resource (src/tools/gallery.ts, docs/media-storage-plan.md §4).
// Same buildGalleryHtml() call, same cards, same client-side filters — the only
// difference is who renders it.
//
// This exists because MCP Apps are opt-in on the CLIENT: a host renders a
// `ui://` resource only if it declared `io.modelcontextprotocol/ui` during
// initialize. Claude Cowork and other Claude Code / Agent SDK hosts do not, so
// `_meta.ui.resourceUri` is dropped silently and the user sees a JSON summary
// where a gallery should be. A URL works in every host, because it is not the
// host's job to render it.
//
// Auth: a narrow, short-lived, audience-pinned token minted during the tool
// call (src/lib/gallery-link.ts). It authorises exactly one thing — render this
// user's gallery — and cannot be replayed against /mcp. The workspace is
// derived from the token's `sub` via runWithUser → requireWorkspace, identical
// to the MCP path, so query params can never widen what is visible.

import { runWithUser } from '../src/context.js';
import { buildGalleryHtml } from '../src/tools/gallery.js';
import { verifyGalleryToken, isGalleryLinkEnabled } from '../src/lib/gallery-link.js';

/**
 * Deny-by-default CSP, mirroring what the MCP App declares via
 * `_meta.ui.csp.resourceDomains` (§4.1). The page is self-contained — inline
 * CSS and inline JS, no fetch at runtime — so only the storage origin is
 * needed, for `img-src` and `media-src`.
 *
 * `'unsafe-inline'` on script-src is required by that self-contained design and
 * is the same trade the sandboxed-iframe version already makes; there is no
 * user-controlled HTML in the document (every field goes through esc() in
 * src/ui/gallery.ts).
 */
function csp(storageOrigin: string | null): string {
  const media = storageOrigin ? `${storageOrigin} data: blob:` : `data: blob:`;
  return [
    "default-src 'none'",
    `img-src ${media}`,
    `media-src ${media}`,
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

export async function GET(request: Request): Promise<Response> {
  if (!isGalleryLinkEnabled()) {
    return page(
      500,
      'Gallery links are not configured',
      'This deployment has no GALLERY_LINK_SECRET (or SUPABASE_SECRET_KEY / CRON_SECRET) set, so gallery links cannot be verified.',
    );
  }

  const url = new URL(request.url);
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
    const { html, cspOrigin } = await runWithUser(userId, () =>
      buildGalleryHtml({
        sourceId: url.searchParams.get('sourceId') ?? undefined,
        minOutlier: num(url.searchParams.get('minOutlier')),
        minViews: num(url.searchParams.get('minViews')),
        density: densityOf(url.searchParams.get('density')),
      }),
    );

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp(cspOrigin),
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
