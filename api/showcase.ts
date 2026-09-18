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

function publicCors(): Record<string, string> {
  // Intentionally open: this endpoint serves only allow-listed public
  // showcase rows (no auth, no user data). The strict origin allowlist in
  // src/lib/cors.ts stays for every credentialed route.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: publicCors() });
}

function showcaseWorkspaceIds(): string[] {
  // No extra worker var (Free plan caps at 64): the default workspace is
  // baked in, overridable via SHOWCASE_WORKSPACE_IDS if that ever changes.
  return (process.env.SHOWCASE_WORKSPACE_IDS ?? 'cf7b725d-6063-461c-ad64-c83c9abab8c9')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function thumbBase(): string {
  return (process.env.R2_THUMB_PUBLIC_BASE ?? '').replace(/\/$/, '');
}

// Manually excluded from the shelf (owner call).
const EXCLUDE_VIDEO_IDS = new Set(['65d08c21-def1-4d71-a703-83f6c99562f3']);

// Niche label for the card: the source's tag, minus noise. Collection
// sources store a full TikTok URL as the query and creator sources repeat
// the handle already shown above the card — both render as ugly raw text,
// so they are dropped (empty niche hides the row client-side).
function cleanNiche(raw: string | null | undefined, creator: string): string {
  if (!raw) return '';
  const n = raw.trim();
  if (!n || /^https?:\/\//i.test(n)) return '';
  if (n.replace(/^[@#]/, '').toLowerCase() === creator.replace(/^@/, '').toLowerCase()) return '';
  if (n.length > 28) return '';
  return n;
}

export async function GET(request: Request): Promise<Response> {
  const ids = showcaseWorkspaceIds();
  if (!ids.length) {
    return json(200, { items: [] });
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
      id: true,
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
  const seen = new Set<string>();
  const items = videos.flatMap((v) => {
    // Same TikTok video can be ingested twice (re-scrapes); the shelf shows
    // each URL once.
    if (!v.thumbKey || !base || EXCLUDE_VIDEO_IDS.has(v.id) || seen.has(v.url)) return [];
    seen.add(v.url);
    return [
      {
        id: v.id,
        creator: v.creatorHandle,
        caption: v.caption ?? '',
        views: v.views,
        score: v.score?.outlierScore ?? 0,
        thumb: `${base}/${v.thumbKey}`,
        url: v.url,
        niche: cleanNiche(v.source?.nicheTag || v.source?.query || '', v.creatorHandle),
        platform: v.source?.platform || 'tiktok',
      },
    ];
  });

  return json(200, { items });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...publicCors() },
  });
}
