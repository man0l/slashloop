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

const DIGEST_MIN_OUTLIER_SCORE = 5;
const TOP_OUTLIERS_IN_DIGEST = 5;

export interface DigestOutlier {
  videoId: string;
  creator: string;
  platform: string;
  source: string;
  url: string;
  views: number;
  outlierScore: number;
  scoreType: 'actual' | 'estimated';
  hasAnalysis: boolean;
  postedAt: string;
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
 * Build the digest payload for a workspace. Read-only — persistence and
 * delivery belong to the cron / get_digest callers.
 */
export async function buildDigest(
  ws: Pick<Workspace, 'id' | 'createdAt' | 'lastDigestAt'>,
  creditsRemaining: number,
): Promise<DigestPayload> {
  const since = sinceFor(ws);
  const wsFilter = { source: { workspaceId: ws.id } };

  const totalVideos = await db.video.count({ where: wsFilter });

  // New scored outliers since the watermark. Over-fetch so the actual-first
  // ranking can cut down to the display size.
  const newScores = await db.score.findMany({
    where: {
      scoredAt: { gt: since },
      outlierScore: { gte: DIGEST_MIN_OUTLIER_SCORE },
      video: wsFilter,
    },
    include: {
      video: {
        select: {
          id: true, creatorHandle: true, platform: true, views: true, url: true, postedAt: true,
          creatorFollowers: true,
          analyses: { select: { videoId: true }, take: 1 },
          source: { select: { query: true } },
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

  const topOutliers: DigestOutlier[] = ranked.slice(0, TOP_OUTLIERS_IN_DIGEST).map(s => ({
    videoId: s.video.id,
    creator: s.video.creatorHandle,
    platform: s.video.platform,
    source: s.video.source.query,
    url: s.video.url,
    views: s.video.views,
    outlierScore: s.outlierScore,
    scoreType: s.scoreType as 'actual' | 'estimated',
    hasAnalysis: s.video.analyses.length > 0,
    postedAt: s.video.postedAt.toISOString(),
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
// An owner may hold several workspaces but gets ONE email: callers pass a
// section per due workspace (quiet ones filtered out upstream) and the
// renderers aggregate counts across them. Layout is single-column,
// 16px-base, thumb-sized tap targets — these are read on phones.
// ---------------------------------------------------------------------------

const fmtViews = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K`
      : `${n}`;

/** Where "Email settings" points. SITE_URL is the slashloop-site frontend. */
function siteUrl(): string {
  return (process.env.SITE_URL ?? 'https://slashloop.dev').replace(/\/$/, '');
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
  return `Slashloop weekly — ${total} breakout video${total === 1 ? '' : 's'}`;
}

export function renderDigestText(sections: DigestSection[]): string {
  const lines: string[] = [];
  lines.push('Slashloop weekly');
  lines.push('');

  if (sections.length === 0 || sumNew(sections) === 0) {
    lines.push('No new breakouts since your last digest. If your sources went quiet, ask Claude: "refresh my sources".');
  }

  for (const s of sections) {
    const p = s.payload;
    if (p.newOutliersCount === 0) continue;
    if (sections.length > 1) {
      lines.push('');
      lines.push(`== ${s.name} ==`);
    }
    lines.push(`Videos that blew up past their creator's usual numbers (${p.newOutliersCount}):`);
    for (const o of p.topOutliers) {
      lines.push(`  • @${o.creator} — ${o.outlierScore.toFixed(0)}× their usual views, ${fmtViews(o.views)} total [${o.source}]`);
      lines.push(`    ${o.url}`);
    }
    const unanalyzed = p.topOutliers.filter(o => !o.hasAnalysis);
    if (unanalyzed.length > 0) {
      lines.push('');
      lines.push(`${unanalyzed.length} not broken down yet. Ask Claude: "analyze the top outliers" to learn why they worked.`);
    }
    lines.push(`Posting queue: ${p.ideas.overdue} overdue, ${p.ideas.dueThisWeek} due this week, ${p.ideas.unscheduled} unscheduled.`);
    lines.push(`Credits left: ${p.creditsRemaining}`);
  }

  lines.push('');
  lines.push(`Manage these emails: ${siteUrl()}/settings/email`);
  lines.push('You get this because you track sources on Slashloop.');
  return lines.join('\n');
}

/** Escape user-scraped strings before they touch HTML. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function outlierCard(o: DigestOutlier): string {
  return `
    <div style="padding:14px 0;border-bottom:1px solid #ececec;">
      <a href="${esc(o.url)}" style="display:block;text-decoration:none;color:#111;">
        <span style="font-size:16px;font-weight:600;">@${esc(o.creator)}</span>
        <span style="display:block;font-size:15px;color:#c2410c;font-weight:600;margin-top:2px;">${o.outlierScore.toFixed(0)}&times; their usual views</span>
        <span style="display:block;font-size:14px;color:#666;margin-top:2px;">${fmtViews(o.views)} views &middot; ${esc(o.source)}</span>
      </a>${
        o.hasAnalysis
          ? ''
          : `<span style="display:inline-block;margin-top:8px;font-size:13px;color:#888;">Not analyzed yet — ask Claude to break it down</span>`
      }
    </div>`;
}

function sectionHtml(s: DigestSection, showHeader: boolean): string {
  const p = s.payload;
  if (p.newOutliersCount === 0) return '';

  const header = showHeader
    ? `<h3 style="font-size:15px;margin:20px 0 4px;color:#111;">${esc(s.name)}</h3>`
    : '';
  const unanalyzed = p.topOutliers.filter(o => !o.hasAnalysis);
  const note = unanalyzed.length > 0
    ? `<p style="font-size:13px;color:#777;margin:10px 0 0;">${unanalyzed.length} of these aren&rsquo;t broken down yet. Ask Claude: <em>&ldquo;analyze the top outliers&rdquo;</em>.</p>`
    : '';
  const queue = p.ideas.overdue > 0 || p.ideas.dueThisWeek > 0
    ? `<p style="font-size:14px;color:#555;margin:14px 0 0;">Posting queue: ${p.ideas.overdue} overdue, ${p.ideas.dueThisWeek} due this week.</p>`
    : '';

  return `${header}
    <p style="font-size:14px;color:#555;margin:6px 0 2px;">Videos that blew up past their creator&rsquo;s usual numbers:</p>
    ${p.topOutliers.map(outlierCard).join('')}
    ${note}${queue}`;
}

export function renderDigestHtml(sections: DigestSection[]): string {
  const showHeaders = sections.length > 1;
  const body = sections.map(s => sectionHtml(s, showHeaders)).join('');

  const content = body ||
    `<p style="font-size:15px;color:#555;">No new breakouts since your last digest. If your sources went quiet, ask Claude to refresh them.</p>`;

  // Mobile-first: one column, 16px+ body text, whole-card tap targets.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>@media(max-width:480px){.wrap{padding:16px !important}}</style></head>
    <body style="margin:0;background:#fafafa;">
    <div class="wrap" style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff;">
      <h2 style="font-size:21px;margin:0 0 2px;color:#111;">Slashloop weekly</h2>
      <p style="font-size:14px;color:#999;margin:0 0 8px;">Videos that beat their creator&rsquo;s usual numbers, from the sources you track.</p>
      ${content}
      <div style="margin-top:22px;">
        <a href="${siteUrl()}/settings/email" style="display:inline-block;padding:11px 18px;border:1px solid #ddd;border-radius:8px;font-size:14px;color:#333;text-decoration:none;">Email settings</a>
      </div>
      <p style="font-size:12px;color:#aaa;margin:18px 0 0;">You get this because you track sources on Slashloop. Turn it off any time in Email settings.</p>
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
