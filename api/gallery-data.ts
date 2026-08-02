// GET /api/gallery-data?workspaceId=&sourceId=&sortBy=&minOutlier=&minViews=&limit=
// JSON cards for the site's Gallery page. Named gallery-data (not gallery) to
// avoid colliding with the existing HTML route at api/gallery.ts (served at
// /gallery via vercel.json).
import { corsPreflight } from '../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../src/lib/authz.js';
import { runWithUser } from '../src/context.js';
import { buildCards } from '../src/tools/gallery.js';
import type { GalleryFilters } from '../src/ui/gallery.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

const SORT_VALUES = new Set<GalleryFilters['sortBy']>(['outlier_score', 'views', 'newest']);

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

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
  // context rather than re-deriving workspace resolution here.
  const { cards, note, filters } = await runWithUser(auth.userId, () =>
    buildCards({
      workspaceId: auth.workspace.id,
      sourceId: url.searchParams.get('sourceId') ?? undefined,
      sortBy,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      minOutlier: Number.isFinite(minOutlierRaw) && minOutlierRaw > 0 ? minOutlierRaw : undefined,
      minViews: Number.isFinite(minViewsRaw) && minViewsRaw > 0 ? minViewsRaw : undefined,
    }),
  );

  return jsonResponse(200, { cards, note, filters });
}
