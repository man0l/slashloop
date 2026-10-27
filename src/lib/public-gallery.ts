// Anonymous read-only gallery for a shared workspace (SLA-1093):
// GET /api/gallery-data?publicToken=<token>. The token resolves the workspace;
// every other scoping param (workspaceId, sourceId, videoId, creatorHandle,
// analyzedBy) is ignored so the link can't be widened, and the pool is pinned
// to the default size. No `note` in the payload (it can name sources).
import { jsonResponse } from './authz.js';
import { findWorkspaceByPublicToken } from './workspaces.js';
import { buildCardsForWorkspace } from '../tools/gallery.js';
import type { GalleryFilters } from '../ui/gallery.js';

export const GALLERY_SORT_VALUES = new Set<GalleryFilters['sortBy']>(['outlier_score', 'views', 'newest']);

/** Matches GALLERY_POOL in src/tools/gallery.ts. */
const PUBLIC_GALLERY_LIMIT = 48;

export async function handlePublicGalleryData(request: Request, url: URL, token: string): Promise<Response> {
  const workspace = await findWorkspaceByPublicToken(token);
  if (!workspace) return jsonResponse(404, { error: 'not_found' }, request);

  const sortByRaw = url.searchParams.get('sortBy') ?? 'outlier_score';
  const sortBy = GALLERY_SORT_VALUES.has(sortByRaw as GalleryFilters['sortBy'])
    ? (sortByRaw as GalleryFilters['sortBy'])
    : 'outlier_score';
  const minOutlierRaw = Number(url.searchParams.get('minOutlier') ?? '');
  const minViewsRaw = Number(url.searchParams.get('minViews') ?? '');

  const { cards, filters } = await buildCardsForWorkspace(workspace, {
    sortBy,
    limit: PUBLIC_GALLERY_LIMIT,
    minOutlier: Number.isFinite(minOutlierRaw) && minOutlierRaw > 0 ? minOutlierRaw : undefined,
    minViews: Number.isFinite(minViewsRaw) && minViewsRaw > 0 ? minViewsRaw : undefined,
  });
  return jsonResponse(200, { workspaceName: workspace.name, cards, filters }, request);
}
