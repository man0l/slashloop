// ---------------------------------------------------------------------------
// Weekly digest — build once per workspace, deliver everywhere.
//
// api/cron/digest.ts calls buildDigest() weekly, stores the payload on the
// workspace row and emails it; the free get_digest tool serves the same
// payload to agents between runs. One builder means email and MCP can never
// drift.
//
// Ranking mirrors get_outlier_summary's rules: `actual` outliers (measured
// against the creator's own median) lead, `estimated` follow, and estimated
// scores whose creator under-reached their own follower base rank last —
// a 438× estimated score in this product's history was really 1.3×.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import type { Workspace } from '@prisma/client';
import { isStorageEnabled, publicUrl, thumbBucket, thumbPath } from './storage.js';
import { backfillThumbsViaOembed } from './media.js';

const DIGEST_MIN_OUTLIER_SCORE = 5;
const TOP_OUTLIERS_IN_DIGEST = 5;

export interface DigestOutlier {
  videoId: string;
  /** Owning workspace — deep links switch the site to it before filtering. */
  workspaceId: string;
  creator: string;
  platform: string;
  source: string;
  url: string;
  views: number;
  outlierScore: number;
  scoreType: 'actual' | 'estimated';
  hasAnalysis: boolean;
  postedAt: string;
  /** Public CDN URL of the vertical thumbnail; null when not stored. */
  thumbUrl: string | null;
}

export interface DigestIdeaStats {
  overdue: number;
  dueThisWeek: number;
  unscheduled: number;
}

export interface DigestPayload {
  /** ISO — when this payload was built. */
  generatedAt: string;
  /** ISO of the watermark used ("new" = scored after this). Null on the first digest. */
  since: string | null;
  totalVideos: number;
  newOutliersCount: number;
  actualNewCount: number;
  topOutliers: DigestOutlier[];
  ideas: DigestIdeaStats;
  creditsRemaining: number;
}

/** The window a digest covers. First run looks back over everything. */
function sinceFor(ws: Pick<Workspace, 'createdAt' | 'lastDigestAt'>): Date {
  return ws.lastDigestAt ?? ws.createdAt;
}

/**
 * Build the digest payload for a workspace. Read-only except for one opportunistic
 * capture: top-outlier thumbnails that were never ingested (status 'none') get
 * backfilled through TikTok oEmbed and stored in our bucket — the digest is the
 * only place a missing cover is visible to a customer, and the top outliers are
 * exactly the videos worth seeing. Pass a `backfillBudget` to enable it; the
 * cron caps the total per run so a large first run can't blow the 60s function.
 */
export async function buildDigest(
  ws: Pick<Workspace, 'id' | 'createdAt' | 'lastDigestAt'>,
  creditsRemaining: number,
  backfillBudget?: { remaining: number },
): Promise<DigestPayload> {
  const since = sinceFor(ws);
  // isBaselineSample: false everywhere a video list is shown — baseline rows
  // are internal scoring history (creator-median deepening), they have no
  // thumbnails by design and the gallery filters them out, so ranking them
  // in the email both shows a gray box AND deep-links to an empty gallery.
  const wsFilter = { source: { workspaceId: ws.id } };

  const totalVideos = await db.video.count({ where: { ...wsFilter, isBaselineSample: false } });

  // New scored outliers since the watermark. Over-fetch so the actual-first
  // ranking can cut down to the display size.
  const newScores = await db.score.findMany({
    where: {
      scoredAt: { gt: since },
      outlierScore: { gte: DIGEST_MIN_OUTLIER_SCORE },
      video: { ...wsFilter, isBaselineSample: false },
    },
    include: {
      video: {
        select: {
          id: true, creatorHandle: true, platform: true, views: true, url: true, postedAt: true,
          creatorFollowers: true, thumbKey: true, thumbStatus: true, thumbnailUrl: true,
          analyses: { select: { videoId: true }, take: 1 },
          source: { select: { query: true, workspaceId: true } },
        },
      },
    },
    orderBy: { outlierScore: 'desc' },
    take: 100,
  });

  // Mirror get_outlier_summary: an estimated score on a creator who reached
  // fewer people than follow them is normal performance, not a breakout.
  const underReaches = (s: typeof newScores[number]): boolean => {
    if (s.scoreType !== 'estimated') return false;
    const f = s.video.creatorFollowers;
    return !!f && f > 0 && s.video.views / f < 1;
  };

  const ranked = [
    ...newScores.filter(s => s.scoreType === 'actual'),
    ...newScores.filter(s => s.scoreType === 'estimated' && !underReaches(s)),
    ...newScores.filter(underReaches),
  ];

  // Opportunistic thumbnail capture for exactly the videos the email will
  // show. Only 'none' rows: 'failed' already had its shot at scrape time and
  // oEmbed backfill deliberately never writes 'failed', so this never
  // re-attempts the same dead cover weekly.
  const needThumb = ranked
    .slice(0, TOP_OUTLIERS_IN_DIGEST)
    .filter(s => s.video.thumbStatus === 'none' && s.video.platform === 'tiktok' && s.video.url);
  if (needThumb.length > 0 && backfillBudget && backfillBudget.remaining > 0 && isStorageEnabled()) {
    const take = needThumb.slice(0, backfillBudget.remaining);
    backfillBudget.remaining -= take.length;
    const outcome = await backfillThumbsViaOembed(ws.id, take.map(s => ({ videoId: s.video.id, url: s.video.url })));
    if (outcome.stored + outcome.failed > 0) {
      console.log(`[digest] thumb backfill ws=${ws.id.slice(0, 8)} stored=${outcome.stored} failed=${outcome.failed}`);
      const refetched = await db.video.findMany({
        where: { id: { in: take.map(s => s.video.id) } },
        select: { id: true, thumbKey: true, thumbStatus: true },
      });
      const byId = new Map(refetched.map(r => [r.id, r]));
      for (const s of take) {
        const r = byId.get(s.video.id);
        if (r?.thumbStatus === 'stored') {
          s.video.thumbKey = r.thumbKey;
          s.video.thumbStatus = r.thumbStatus;
        }
      }
    }
  }

  const thumbUrlFor = (s: (typeof ranked)[number]): string | null => {
    if (s.video.thumbStatus !== 'stored' || !s.video.thumbKey) return null;
    try {
      // Throws when the R2 public base isn't configured — a digest without
      // thumbnails beats a crashed cron.
      return publicUrl(thumbBucket(), thumbPath(s.video.source.workspaceId, s.video.id));
    } catch {
      return null;
    }
  };

  const topOutliers: DigestOutlier[] = ranked.slice(0, TOP_OUTLIERS_IN_DIGEST).map(s => ({
    videoId: s.video.id,
    workspaceId: s.video.source.workspaceId,
    creator: s.video.creatorHandle,
    platform: s.video.platform,
    source: s.video.source.query,
    url: s.video.url,
    views: s.video.views,
    outlierScore: s.outlierScore,
    scoreType: s.scoreType as 'actual' | 'estimated',
    hasAnalysis: s.video.analyses.length > 0,
    postedAt: s.video.postedAt.toISOString(),
    thumbUrl: thumbUrlFor(s),
  }));

  // Idea queue stats — cadence is the #1 indie pain point, so the digest
  // always reports whether the posting queue is healthy.
  const now = Date.now();
  const weekAhead = new Date(now + 7 * 24 * 60 * 60 * 1000);
  const ideas = await db.idea.findMany({
    where: { status: { not: 'archived' }, video: wsFilter },
    select: { dueAt: true },
  });
  const ideaStats: DigestIdeaStats = {
    overdue: ideas.filter(i => i.dueAt && i.dueAt.getTime() < now).length,
    dueThisWeek: ideas.filter(i => i.dueAt && i.dueAt.getTime() >= now && i.dueAt <= weekAhead).length,
    unscheduled: ideas.filter(i => !i.dueAt).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    since: ws.lastDigestAt?.toISOString() ?? null,
    totalVideos,
    newOutliersCount: newScores.length,
    actualNewCount: newScores.filter(s => s.scoreType === 'actual').length,
    topOutliers,
    ideas: ideaStats,
    creditsRemaining,
  };
}

// ---------------------------------------------------------------------------
// Email rendering — plain text first, HTML as a styled mirror of it.
//
// Every link goes into the APP (slashloop.dev/gallery?video=<id>), never to
// TikTok — the email is a doorway, not a detour. Copy is deliberately terse:
// thumbnails and one multiplier number carry the meaning; no explanatory
// phrases. An owner may hold several workspaces but gets ONE email: callers
// pass a section per due workspace (quiet ones filtered out upstream).
// ---------------------------------------------------------------------------

const fmtViews = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K`
      : `${n}`;

/** Where "Email settings" points. SITE_URL is the slashloop-site frontend. */
function siteUrl(): string {
  return (process.env.SITE_URL ?? 'https://slashloop.dev').replace(/\/$/, '');
}

/**
 * Deep link into the gallery showing exactly this video. The workspace param
 * makes the link self-contained: an owner with several workspaces lands on
 * the right one without touching the switcher, and the video param filters
 * the grid down to that single card.
 */
export function videoLink(videoId: string, workspaceId?: string): string {
  const ws = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : '';
  return `${siteUrl()}/gallery?video=${encodeURIComponent(videoId)}${ws}`;
}

export interface DigestSection {
  /** Workspace name — becomes the section header when there are several. */
  name: string;
  payload: DigestPayload;
}

const sumNew = (sections: DigestSection[]): number => sections.reduce((n, s) => n + s.payload.newOutliersCount, 0);

export function digestSubject(sections: DigestSection[]): string {
  const total = sumNew(sections);
  if (total === 0) return 'Slashloop weekly — nothing new this week';
  return `Slashloop weekly — ${total} taking off`;
}

export function renderDigestText(sections: DigestSection[]): string {
  const lines: string[] = [];
  lines.push('Slashloop weekly');
  lines.push('');

  if (sections.length === 0 || sumNew(sections) === 0) {
    lines.push('Nothing new this week.');
    lines.push('');
    lines.push(`Email settings: ${siteUrl()}/settings/email`);
    return lines.join('\n');
  }

  for (const s of sections) {
    if (s.payload.newOutliersCount === 0) continue;
    if (sections.length > 1) {
      lines.push('');
      lines.push(`== ${s.name} ==`);
    }
    for (const o of s.payload.topOutliers) {
      lines.push(`  • @${o.creator} — ${o.outlierScore.toFixed(0)}× · ${fmtViews(o.views)} views`);
      lines.push(`    Open in Slashloop: ${videoLink(o.videoId, o.workspaceId)}`);
    }
    if (s.payload.ideas.overdue > 0) lines.push(`  ${s.payload.ideas.overdue} post(s) overdue in your queue`);
  }

  lines.push('');
  lines.push(`Email settings: ${siteUrl()}/settings/email`);
  return lines.join('\n');
}

/** Escape user-scraped strings before they touch HTML. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One tappable row: vertical thumb on the left, numbers on the right. */
function outlierCard(o: DigestOutlier): string {
  // Margins via margin-right on the thumb, not flex `gap` — `gap` in flex is
  // still dropped by a number of webmail clients, which rendered the rows
  // edge-to-edge (the "no margins" screenshot). Same reason for the roomy
  // row padding instead of relying on the wrapper alone.
  const thumbStyle = 'display:block;width:64px;height:114px;object-fit:cover;border-radius:8px;margin:0 14px 0 4px;flex-shrink:0;';
  const thumb = o.thumbUrl
    ? `<img src="${esc(o.thumbUrl)}" alt="" width="64" height="114" style="${thumbStyle}" />`
    : `<div style="${thumbStyle}background:#f0f0f0;"></div>`;
  return `
    <a href="${esc(videoLink(o.videoId, o.workspaceId))}" style="display:flex;align-items:center;padding:14px 8px;border-bottom:1px solid #ececec;text-decoration:none;">
      ${thumb}
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-size:15px;font-weight:600;color:#111;overflow:hidden;text-overflow:ellipsis;">@${esc(o.creator)}</span>
        <span style="display:block;font-size:22px;font-weight:800;color:#FF4D00;margin-top:4px;">${o.outlierScore.toFixed(0)}×</span>
        <span style="display:block;font-size:13px;color:#777;margin-top:2px;">${fmtViews(o.views)} views &middot; ${esc(o.source)}</span>
      </span>
    </a>`;
}

function sectionHtml(s: DigestSection, showHeader: boolean): string {
  const p = s.payload;
  if (p.newOutliersCount === 0) return '';

  const header = showHeader
    ? `<h3 style="font-size:14px;margin:18px 0 2px;color:#111;">${esc(s.name)}</h3>`
    : '';
  const queue = p.ideas.overdue > 0
    ? `<p style="font-size:13px;color:#777;margin:10px 0 0;">${p.ideas.overdue} post${p.ideas.overdue === 1 ? '' : 's'} overdue in your queue</p>`
    : '';

  return `${header}${p.topOutliers.map(outlierCard).join('')}${queue}`;
}

export function renderDigestHtml(sections: DigestSection[]): string {
  const showHeaders = sections.length > 1;
  const body = sections.map(s => sectionHtml(s, showHeaders)).join('');

  const content = body || `<p style="font-size:15px;color:#555;">Nothing new this week.</p>`;

  // Mobile-first: one column, big numbers, whole-row tap targets.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>@media(max-width:480px){.wrap{padding:16px !important}}</style></head>
    <body style="margin:0;background:#fafafa;">
    <div class="wrap" style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff;">
      <h2 style="font-size:21px;margin:0 0 2px;color:#111;">Slashloop weekly</h2>
      <p style="font-size:14px;color:#999;margin:0 0 6px;">Taking off in your niches right now — the number is views vs the creator&rsquo;s norm.</p>
      ${content}
      <p style="text-align:center;margin-top:24px;">
        <a href="${siteUrl()}/settings/email" style="font-size:13px;color:#aaa;">Email settings</a>
      </p>
    </div></body></html>`;
}

/**
 * Resolve the workspace owner's email straight from Supabase auth over the
 * direct Postgres connection (the postgres role can read auth.users; no
 * service-role key needed). Returns null when there is no owner (local dev)
 * or the row is gone.
 */
export async function ownerEmail(ownerId: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ email: string | null }>>(
    `SELECT email FROM auth.users WHERE id = $1::uuid LIMIT 1`,
    ownerId,
  );
  return rows[0]?.email ?? null;
}
