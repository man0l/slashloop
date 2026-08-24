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
// ---------------------------------------------------------------------------

const fmtViews = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K`
      : `${n}`;

export function digestSubject(p: DigestPayload): string {
  if (p.newOutliersCount === 0) return 'Slashloop weekly — quiet week in your niches';
  return `Slashloop weekly — ${p.newOutliersCount} new outlier${p.newOutliersCount === 1 ? '' : 's'}, ${p.actualNewCount} verified`;
}

export function renderDigestText(p: DigestPayload): string {
  const lines: string[] = [];
  lines.push('Slashloop weekly digest');
  lines.push('');

  if (p.topOutliers.length === 0) {
    lines.push('No new outliers since the last digest. If your sources have gone quiet, refresh them or track something new — ask Claude: "discover sources about <my niche>".');
  } else {
    lines.push(`New outliers since ${p.since ? p.since.slice(0, 10) : 'the beginning'} (${p.newOutliersCount}, ${p.actualNewCount} verified against their creator's own baseline):`);
    for (const o of p.topOutliers) {
      lines.push(`  • @${o.creator} — ${o.outlierScore.toFixed(0)}× ${o.scoreType}, ${fmtViews(o.views)} views [${o.source}]`);
      lines.push(`    ${o.url}`);
    }
    const unanalyzed = p.topOutliers.filter(o => !o.hasAnalysis);
    if (unanalyzed.length > 0) {
      lines.push('');
      lines.push(`${unanalyzed.length} of these are not analyzed yet. Ask Claude: "analyze the top outliers" (5 credits each) to turn them into hooks and scripts.`);
    }
  }

  lines.push('');
  lines.push(`Posting queue: ${p.ideas.overdue} overdue, ${p.ideas.dueThisWeek} due this week, ${p.ideas.unscheduled} unscheduled.`);
  if (p.ideas.overdue > 0 || p.ideas.unscheduled > 3) {
    lines.push('Ask Claude: "what should I post today?"');
  }
  lines.push('');
  lines.push(`Credits remaining: ${p.creditsRemaining}`);
  lines.push('');
  lines.push('You receive this because you track sources on Slashloop. Disable it any time: ask Claude to set digestEnabled=false.');
  return lines.join('\n');
}

/** Escape user-scraped strings before they touch HTML. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDigestHtml(p: DigestPayload): string {
  const rows = p.topOutliers.map(o => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;">
        <a href="${esc(o.url)}" style="color:#111;text-decoration:none;font-weight:600;">@${esc(o.creator)}</a>
        <span style="color:#888;"> · ${o.outlierScore.toFixed(0)}× ${esc(o.scoreType)} · ${fmtViews(o.views)} views · ${esc(o.source)}</span><br/>
        <span style="color:#aaa;font-size:12px;">${o.hasAnalysis ? '' : 'not analyzed yet'}</span>
      </td>
    </tr>`).join('');

  const body = p.topOutliers.length === 0
    ? '<p style="color:#555;">No new outliers since your last digest. Refresh stale sources or ask Claude to discover new ones.</p>'
    : `<p style="color:#555;">${p.newOutliersCount} new outlier(s), ${p.actualNewCount} verified against their creator's own baseline:</p>
       <table style="border-collapse:collapse;width:100%;">${rows}</table>`;

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;">
    <h2 style="margin:0 0 4px;">Slashloop weekly</h2>
    <p style="color:#888;margin:0 0 16px;">${esc(p.since ? `since ${p.since.slice(0, 10)}` : 'first digest')}</p>
    ${body}
    <p style="color:#555;margin-top:16px;"><strong>Posting queue:</strong> ${p.ideas.overdue} overdue, ${p.ideas.dueThisWeek} due this week, ${p.ideas.unscheduled} unscheduled.</p>
    <p style="color:#888;">Credits remaining: ${p.creditsRemaining}</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
    <p style="color:#aaa;font-size:12px;">You track sources on Slashloop. Ask Claude to set digestEnabled=false to stop these emails.</p>
  </body></html>`;
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
