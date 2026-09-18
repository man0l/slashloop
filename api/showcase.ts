// GET /api/showcase — public outlier shelf for the marketing site's home
// page. No auth: serves only explicitly allow-listed showcase workspaces
// (SHOWCASE_WORKSPACE_IDS, comma-separated) so no tenant data can leak.
//
// Expiry rule (the point of the endpoint): only videos whose thumbnail is
// persisted in R2 (thumbStatus = 'stored') are served — R2 URLs never rot,
// unlike TikTok's signed CDN URLs. Anything else is silently skipped.
// Self sources (the owner's own videos) are excluded; the shelf shows niche
// outliers only. Each item carries its source niche (nicheTag ?? query).

import { db } from '../src/db.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

function showcaseWorkspaceIds(): string[] {
  return (process.env.SHOWCASE_WORKSPACE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function thumbBase(): string {
  return (process.env.R2_THUMB_PUBLIC_BASE ?? '').replace(/\/$/, '');
}

export async function GET(request: Request): Promise<Response> {
  const ids = showcaseWorkspaceIds();
  if (!ids.length) {
    return json(200, { items: [] }, request);
  }

  const videos = await db.video.findMany({
    where: {
      isBaselineSample: false,
      thumbStatus: 'stored',
      thumbKey: { not: null },
      source: { workspaceId: { in: ids }, isSelf: false },
      score: { outlierScore: { gte: 4 } },
    },
    orderBy: { score: { outlierScore: 'desc' } },
    take: 12,
    select: {
      creatorHandle: true,
      caption: true,
      views: true,
      url: true,
      thumbKey: true,
      score: { select: { outlierScore: true } },
      source: { select: { query: true, nicheTag: true, platform: true } },
    },
  });

  const base = thumbBase();
  const items = videos.flatMap((v) => {
    if (!v.thumbKey || !base) return [];
    return [
      {
        creator: v.creatorHandle,
        caption: v.caption ?? '',
        views: v.views,
        score: v.score?.outlierScore ?? 0,
        thumb: `${base}/${v.thumbKey}`,
        url: v.url,
        niche: v.source?.nicheTag || v.source?.query || '',
        platform: v.source?.platform || 'tiktok',
      },
    ];
  });

  return json(200, { items }, request);
}

function json(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}
