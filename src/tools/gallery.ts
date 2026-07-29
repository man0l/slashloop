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

import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { resolveThumbUrl, signedMediaUrl, frameUrlAt } from '../lib/media.js';
import { renderGallery, type GalleryCard } from '../ui/gallery.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GALLERY_URI = 'ui://slashloop/gallery.html';

/** Cards to render. Kept small: each one may hold a video element. */
const GALLERY_LIMIT = 12;

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

async function buildCards(): Promise<{ cards: GalleryCard[]; note?: string }> {
  const workspace = await requireWorkspace();

  const videos = await db.video.findMany({
    where: { source: { workspaceId: workspace.id } },
    include: { score: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: [{ views: 'desc' }],
    take: GALLERY_LIMIT,
  });

  const cards: GalleryCard[] = [];
  for (const v of videos) {
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
  const note = withMedia === 0 && cards.length > 0
    ? 'No stored video in this set — playback and key-moment seeking need an analysed video inside the retention window.'
    : undefined;

  return { cards, note };
}

export function registerGalleryApp(server: McpServer) {
  registerAppTool(
    server,
    'show_gallery',
    {
      title: 'Show the outlier gallery',
      description:
        'Render the workspace\'s top videos as an interactive gallery inside the conversation — '
        + 'stored thumbnails, inline playback where a video is still stored, and clickable key moments '
        + 'that seek the player to the frame worth recreating. Use when the user wants to SEE their '
        + 'outliers rather than read a list; get_feed remains the text answer.',
      inputSchema: {},
      _meta: { ui: { resourceUri: GALLERY_URI } },
    },
    async () => {
      const { cards } = await buildCards();
      // The app renders itself from the inlined resource; this text is what the
      // model reads, so keep it a summary rather than a duplicate of the cards.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Gallery rendered',
            videos: cards.length,
            withStoredVideo: cards.filter(c => c.mediaUrl).length,
            withKeyMoments: cards.filter(c => c.keyMoments.length > 0).length,
          }, null, 2),
        }],
      };
    },
  );

  registerAppResource(
    server,
    'slashloop gallery',
    GALLERY_URI,
    { description: 'Interactive gallery of the workspace\'s outlier videos.' },
    async () => {
      const { cards, note } = await buildCards();
      const origin = storageOrigin();

      return {
        contents: [{
          uri: GALLERY_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: renderGallery(cards, note),
          _meta: {
            ui: {
              // §4.1. resourceDomains maps to img-src, script-src, style-src,
              // font-src AND media-src (per the extension's spec types), so this
              // one origin covers both the public thumbs and the signed MP4s.
              // No connectDomains: the page fetches nothing at runtime.
              csp: { resourceDomains: origin ? [origin] : [] },
            },
          },
        }],
      };
    },
  );
}
