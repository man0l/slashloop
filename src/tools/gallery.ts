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
import type { Prisma } from '@prisma/client';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { db } from '../db.js';
import { requireWorkspace, currentUserId } from '../context.js';
import { resolveThumbUrl, signedMediaUrl } from '../lib/media.js';
import { signGalleryUrl, ttlHumanized } from '../lib/gallery-link.js';
import { withNextSteps, analyzeCostLabel } from '../lib/next-steps.js';
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
  /** Server-side ranking. Default 'outlier_score' — see the sort split below. */
  sortBy?: GalleryFilters['sortBy'];
  /** Resolve a specific workspace (REST API) instead of the caller's primary one (MCP tools). */
  workspaceId?: string;
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
  const workspace = await requireWorkspace(opts.workspaceId ? { workspaceId: opts.workspaceId } : undefined);
  const limit = Math.min(Math.max(opts.limit ?? GALLERY_POOL, 1), 60);
  const sortBy = opts.sortBy ?? 'outlier_score';

  const where: {
    source: { workspaceId: string };
    sourceId?: string;
  } = { source: { workspaceId: workspace.id } };
  if (opts.sourceId) where.sourceId = opts.sourceId;

  const include = { score: true, analyses: { orderBy: { createdAt: 'desc' as const }, take: 1 } };
  type VideoCardRow = Prisma.VideoGetPayload<{ include: { score: true; analyses: true } }>;

  let ranked: VideoCardRow[];

  if (sortBy === 'views' || sortBy === 'newest') {
    // Single query, no scored/unscored split needed — views and postedAt are
    // never null, so a plain ORDER BY already returns the true top-N.
    ranked = await db.video.findMany({
      where,
      include,
      orderBy: sortBy === 'views' ? { views: 'desc' } : { postedAt: 'desc' },
      take: limit,
    });
  } else {
    // Rank by Score.outlierScore in the DB so the pool is the true top-N
    // workspace outliers — not "top of an arbitrary unpaged slice".
    //
    // Split scored from unscored rather than relying on a single ORDER BY:
    // Postgres defaults DESC to NULLS FIRST and Prisma cannot express nulls
    // ordering through a relation, so an unsplit query can hand back a pool
    // made entirely of unscored videos. An in-memory re-sort cannot repair
    // that — the wrong rows were already selected. Same fix as get_feed.
    const videos = await db.video.findMany({
      where: { ...where, score: { isNot: null } },
      include,
      orderBy: { score: { outlierScore: 'desc' } },
      take: limit,
    });

    // Only backfill with unscored videos if the workspace has too few scored
    // ones to fill the pool — otherwise a fresh workspace renders an empty
    // gallery while it clearly has videos.
    if (videos.length < limit) {
      const unscored = await db.video.findMany({
        where: { ...where, score: { is: null } },
        include,
        orderBy: { postedAt: 'desc' },
        take: limit - videos.length,
      });
      videos.push(...unscored);
    }

    // Scores are non-null by construction above, but the backfill rows are not;
    // treat missing as 0 so they sort last.
    ranked = [...videos].sort(
      (a, b) => (b.score?.outlierScore ?? 0) - (a.score?.outlierScore ?? 0),
    );
  }

  const filters: GalleryFilters = {
    minOutlier: opts.minOutlier && opts.minOutlier > 0 ? opts.minOutlier : 0,
    minViews: opts.minViews && opts.minViews > 0 ? opts.minViews : 0,
    sortBy,
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
      postedAt: v.postedAt.getTime(),
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
        + 'Returns a galleryUrl as well: if the gallery does not render inline in this host, '
        + 'surface that URL to the user as a clickable link — it opens the same interactive '
        + 'gallery in their browser. '
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

      // Second delivery route (api/gallery.ts).
      //
      // Measured, not assumed: the host DOES negotiate MCP Apps. The
      // capability log in api/mcp.ts records, on every initialize,
      //   mcp-apps host="claude-ai" ui=true mimeTypes=["text/html;profile=mcp-app"]
      // — the exact MIME type this resource serves. Capability, tool _meta and
      // resource type are all correct, and the iframe still never appears.
      // That is ext-apps#671, a host-side rendering bug, not something fixable
      // from here. So the signed URL is the reliable path to the same HTML and
      // stays regardless of what the host claims to support.
      const galleryUrl = await signGalleryUrl(currentUserId(), {
        sourceId,
        minOutlier: minOutlierScore,
        minViews,
        density,
      });

      // The forward edge out of the gallery. Viewing is where this product's
      // funnel historically stopped dead — plenty of scored outliers, zero
      // analyses — so the result carries the analysis move, aimed at the
      // videos actually worth spending on.
      //
      // `actual` scores compare a creator to their own baseline; `estimated`
      // compares a video to its source's median, which mostly rewards large
      // accounts posting normally into a tracked hashtag. Suggest the former.
      const ws = await requireWorkspace();
      const candidates = await db.video.findMany({
        where: {
          source: { workspaceId: ws.id },
          ...(sourceId ? { sourceId } : {}),
          analyses: { none: {} },
          score: { scoreType: 'actual', outlierScore: { gte: 5 } },
        },
        include: { score: true },
        orderBy: { score: { outlierScore: 'desc' } },
        take: 5,
      });

      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'resource_link'; uri: string; name: string; description: string; mimeType: string }
      > = [{
        type: 'text' as const,
        text: JSON.stringify(withNextSteps({
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
          galleryUrl,
          // Addressed to the model, not the user: hosts that never render the
          // ui:// resource have no other way to know a real gallery exists.
          hostNote: galleryUrl
            ? `If the interactive gallery did not appear in this conversation, this host did not render the MCP App. Give the user the galleryUrl above as a clickable link — it opens the same interactive gallery in their browser and is valid for ${ttlHumanized()}.`
            : 'No gallery link available (no signing secret or public origin configured). If the interactive gallery did not render, summarise topOutlierScores as text instead.',
        }, [
          candidates.length > 0 ? {
            label: candidates.length === 1
              ? `Analyze @${candidates[0]!.creatorHandle}'s ${candidates[0]!.score?.outlierScore.toFixed(0)}× breakout`
              : `Analyze the ${candidates.length} real outliers`,
            tool: 'analyze_video',
            args: { videoId: candidates[0]!.id },
            cost: analyzeCostLabel(candidates.length),
            spendsMoney: true,
            why: `These are the only unanalyzed videos scored against their creator's own baseline (${candidates
              .map(c => `@${c.creatorHandle} ${c.score?.outlierScore.toFixed(0)}×`)
              .join(', ')}). Analysis is per-video — call analyze_video once per id, and confirm the total first.`,
          } : null,
          candidates.length === 0 ? {
            label: 'Pull fresh videos for these sources',
            tool: 'refresh_source',
            cost: 'live Apify scrape — quote the source before running',
            spendsMoney: true,
            why: 'Every scored outlier here is already analyzed, or none has a creator-relative score yet. More history per creator turns estimated scores into actual ones.',
          } : null,
        ]), null, 2),
      }];

      // A first-class link block for hosts that surface resource_link content.
      if (galleryUrl) {
        content.push({
          type: 'resource_link' as const,
          uri: galleryUrl,
          name: 'Open the outlier gallery',
          description: `Interactive gallery of ${cards.length} videos — thumbnails, filters, and playback where media is stored. Link valid for ${ttlHumanized()}.`,
          mimeType: 'text/html',
        });
      }

      return {
        content,
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
