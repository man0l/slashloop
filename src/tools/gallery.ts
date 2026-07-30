// ---------------------------------------------------------------------------
// MCP App registration — the outlier gallery. docs/media-storage-plan.md §4.
//
// §4.1 is the CSP declaration below. The host renders the app in a sandboxed
// iframe with a deny-by-default policy, so every origin the page touches has to
// be named. One entry covers both buckets, images and video alike, which is why
// the page is deliberately self-contained otherwise.
//
// The data is inlined into the HTML at resource-read time rather than pushed to
// the app as a tool result. That trades live updates for not needing a client
// bundle, a build step or the postMessage handshake — worth it while the open
// question is still whether the host renders media at all (§4.3).
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { resolveThumbUrl, signedMediaUrl } from '../lib/media.js';
import { renderGallery, type GalleryCard, type GalleryFilters } from '../ui/gallery.js';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GALLERY_URI = 'ui://slashloop/gallery.html';
/** RFC 6570 template so hosts can resources/read a source-scoped gallery. */
const GALLERY_URI_TEMPLATE = 'ui://slashloop/gallery.html{?sourceId,minOutlier,density}';

/**
 * Cards inlined into the HTML for client-side filters. Larger than the old
 * visible-only limit so the outlier dropdown still has rows after ≥10x etc.
 * Each card may hold a <video>; only stored media mints a signed URL.
 */
const GALLERY_POOL = 48;

export interface BuildCardsOptions {
  /** When set, only videos from this source (e.g. just after a refresh). */
  sourceId?: string;
  /** Cap on cards in the filter pool (default 48, max 60). */
  limit?: number;
  /** Initial min outlier score for the toolbar dropdown (0 = any). */
  minOutlier?: number;
  /** Initial min views for the toolbar dropdown (0 = any). */
  minViews?: number;
  /** Initial thumbnail density for the toolbar dropdown. */
  density?: GalleryFilters['density'];
}

/**
 * The single origin the app is allowed to load anything from.
 *
 * Derived from SUPABASE_URL rather than hardcoded so a fork or a staging
 * project does not silently render a blank gallery — a wrong origin here fails
 * as a CSP violation in a sandboxed iframe, which is close to invisible.
 */
function storageOrigin(): string | null {
  const raw = process.env.SUPABASE_URL;
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

/**
 * Load gallery cards for the current workspace.
 *
 * Sorted by outlier score (desc), same ranking as `get_feed` — not raw views —
 * so scraped outliers surface even when absolute view counts are modest.
 * Exported for the local HTML preview script (no Claude required).
 */
export async function buildCards(
  opts: BuildCardsOptions = {},
): Promise<{ cards: GalleryCard[]; note?: string; sourceId?: string; filters: GalleryFilters }> {
  const workspace = await requireWorkspace();
  const limit = Math.min(Math.max(opts.limit ?? GALLERY_POOL, 1), 60);

  const where: {
    source: { workspaceId: string };
    sourceId?: string;
  } = { source: { workspaceId: workspace.id } };
  if (opts.sourceId) where.sourceId = opts.sourceId;

  // Rank by Score.outlierScore in the DB so the pool is the true top-N
  // workspace outliers — not "top of an arbitrary unpaged slice".
  const videos = await db.video.findMany({
    where,
    include: { score: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { score: { outlierScore: 'desc' } },
    take: limit,
  });

  // Defensive re-sort: null scores (no Score row) can land first depending on
  // the nulls-ordering of the dialect; treat missing as 0.
  const ranked = [...videos].sort(
    (a, b) => (b.score?.outlierScore ?? 0) - (a.score?.outlierScore ?? 0),
  );

  const filters: GalleryFilters = {
    minOutlier: opts.minOutlier && opts.minOutlier > 0 ? opts.minOutlier : 0,
    minViews: opts.minViews && opts.minViews > 0 ? opts.minViews : 0,
    sortBy: 'outlier_score',
    density: opts.density,
  };

  const cards: GalleryCard[] = [];
  for (const v of ranked) {
    const media = await signedMediaUrl(v);

    let keyMoments: GalleryCard['keyMoments'] = [];
    if (v.analyses[0]) {
      try {
        const parsed = JSON.parse(v.analyses[0].analysisJson) as { keyMoments?: unknown };
        if (Array.isArray(parsed.keyMoments)) {
          keyMoments = parsed.keyMoments.map((m) => {
            const o = m as Record<string, unknown>;
            return {
              timestampSec: typeof o.timestampSec === 'number' ? o.timestampSec : 0,
              role: String(o.role ?? 'other'),
              subjectAction: String(o.subjectAction ?? ''),
              framing: o.framing == null ? null : String(o.framing),
              lighting: o.lighting == null ? null : String(o.lighting),
            };
          });
        }
      } catch { /* a malformed analysis costs its key moments, nothing else */ }
    }

    cards.push({
      id: v.id,
      creatorHandle: v.creatorHandle,
      caption: v.caption,
      url: v.url,
      thumbUrl: resolveThumbUrl(v),
      views: v.views,
      engagementRate: v.views > 0
        ? `${((v.likes + v.comments + (v.shares ?? 0)) / v.views * 100).toFixed(1)}%`
        : '0%',
      outlierScore: v.score?.outlierScore ?? null,
      durationSec: v.durationSec,
      mediaUrl: media.url,
      keyMoments,
    });
  }

  const withMedia = cards.filter(c => c.mediaUrl).length;
  const notes: string[] = [];
  if (opts.sourceId) {
    notes.push(`Filtered to source ${opts.sourceId}.`);
  }
  if (withMedia === 0 && cards.length > 0) {
    notes.push(
      'No stored video in this set — playback and key-moment seeking need an analysed video inside the retention window.',
    );
  }
  if (cards.length === 0) {
    notes.push(
      opts.sourceId
        ? 'No videos for this source yet. Run refresh_source, then show_gallery again.'
        : 'No videos yet. Track a source and run refresh_source.',
    );
  }

  return {
    cards,
    note: notes.length ? notes.join(' ') : undefined,
    sourceId: opts.sourceId,
    filters,
  };
}

/** Full gallery document for a workspace — used by the MCP resource and the local preview. */
export async function buildGalleryHtml(opts: BuildCardsOptions = {}): Promise<{
  html: string;
  cards: GalleryCard[];
  note?: string;
  cspOrigin: string | null;
  filters: GalleryFilters;
}> {
  const { cards, note, filters } = await buildCards(opts);
  return {
    html: renderGallery(cards, note, filters),
    cards,
    note,
    cspOrigin: storageOrigin(),
    filters,
  };
}

export function registerGalleryApp(server: McpServer) {
  registerAppTool(
    server,
    'show_gallery',
    {
      title: 'Show the outlier gallery',
      description:
        'Render the workspace\'s top videos as an interactive gallery inside the conversation — '
        + 'stored thumbnails, inline playback where a video is still stored, clickable key moments, '
        + 'and in-UI filters (outlier score dropdown, min views, sort). '
        + 'ALWAYS call this after a successful refresh_source (or track+refresh) so the user can SEE '
        + 'the scraped videos rather than only a text count. Also use when the user wants to view, '
        + 'browse, or look at their outliers/videos. Sorted by outlier score by default. '
        + 'Pass minOutlierScore (e.g. 5 or 10) to pre-select the outlier filter. '
        + 'Pass sourceId after refreshing a specific source to scope the gallery to that scrape. '
        + 'get_feed remains the text-only answer.',
      inputSchema: {
        sourceId: z
          .string()
          .optional()
          .describe('Optional source id — scope the gallery to videos from this source (e.g. after refresh_source)'),
        minOutlierScore: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe('Pre-select the outlier score filter: 0=any, 2, 5, 10, 25, 50, or 100'),
        minViews: z
          .number()
          .min(0)
          .optional()
          .describe('Pre-select min views filter (0, 10000, 100000, 1000000, 10000000)'),
        limit: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe('Max cards in the filter pool (default 48)'),
        density: z
          .enum(['large', 'medium', 'small', 'list'])
          .optional()
          .describe('Initial thumbnail layout: large, medium (default), small, or list (smallest, one row each)'),
      },
      // Hosts read this from the tool *definition*. Result-level resourceUri is
      // also set below so hosts that honour call-time overrides can apply sourceId.
      _meta: { ui: { resourceUri: GALLERY_URI } },
    },
    async ({ sourceId, minOutlierScore, minViews, limit, density }) => {
      const { cards, filters } = await buildCards({
        sourceId,
        limit,
        minOutlier: minOutlierScore,
        minViews,
        density,
      });
      // Prefer a query-scoped URI when filtering so resources/read can match.
      const qs = new URLSearchParams();
      if (sourceId) qs.set('sourceId', sourceId);
      if (minOutlierScore && minOutlierScore > 0) qs.set('minOutlier', String(minOutlierScore));
      if (density) qs.set('density', density);
      const q = qs.toString();
      const resourceUri = q ? `${GALLERY_URI}?${q}` : GALLERY_URI;

      const minO = filters.minOutlier ?? 0;
      const visible = cards.filter(c => (c.outlierScore ?? 0) >= minO).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Gallery rendered',
            videosInPool: cards.length,
            visibleWithInitialFilter: visible,
            sourceId: sourceId ?? null,
            filters,
            withStoredVideo: cards.filter(c => c.mediaUrl).length,
            withKeyMoments: cards.filter(c => c.keyMoments.length > 0).length,
            topOutlierScores: cards
              .slice(0, 5)
              .map(c => ({ id: c.id, handle: c.creatorHandle, outlierScore: c.outlierScore })),
          }, null, 2),
        }],
        _meta: {
          ui: { resourceUri },
          'ui/resourceUri': resourceUri,
        },
      };
    },
  );

  const resourceMeta = (cspOrigin: string | null) => ({
    ui: {
      // §4.1. resourceDomains maps to img-src, script-src, style-src,
      // font-src AND media-src (per the extension's spec types), so this
      // one origin covers both the public thumbs and the signed MP4s.
      // No connectDomains: the page fetches nothing at runtime.
      csp: { resourceDomains: cspOrigin ? [cspOrigin] : [] },
    },
  });

  // Exact URI — what Claude uses from the tool definition's resourceUri.
  registerAppResource(
    server,
    'slashloop gallery',
    GALLERY_URI,
    { description: 'Interactive gallery of the workspace\'s outlier videos (sorted by outlier score, with filters).' },
    async () => {
      const { html, cspOrigin } = await buildGalleryHtml();
      return {
        contents: [{
          uri: GALLERY_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: resourceMeta(cspOrigin),
        }],
      };
    },
  );

  // Query-scoped reads (tool result _meta may point here after refresh_source).
  // Exact-match registration above does not cover ?sourceId=… / ?minOutlier=….
  server.registerResource(
    'slashloop gallery (filtered)',
    new ResourceTemplate(GALLERY_URI_TEMPLATE, { list: undefined }),
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'Outlier gallery with optional sourceId and minOutlier query params.',
    },
    async (uri, variables) => {
      const rawSource = variables.sourceId;
      const sourceId = Array.isArray(rawSource) ? rawSource[0] : rawSource;
      const rawMin = variables.minOutlier;
      const minRaw = Array.isArray(rawMin) ? rawMin[0] : rawMin;
      const minOutlier = minRaw != null && minRaw !== '' ? Number(minRaw) : undefined;
      const rawDensity = variables.density;
      const dRaw = Array.isArray(rawDensity) ? rawDensity[0] : rawDensity;
      const density = dRaw === 'large' || dRaw === 'medium' || dRaw === 'small' || dRaw === 'list' ? dRaw : undefined;
      const { html, cspOrigin } = await buildGalleryHtml({
        sourceId: typeof sourceId === 'string' ? sourceId : undefined,
        minOutlier: Number.isFinite(minOutlier) ? minOutlier : undefined,
        density,
      });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: resourceMeta(cspOrigin),
        }],
      };
    },
  );
}
