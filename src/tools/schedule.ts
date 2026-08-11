// ---------------------------------------------------------------------------
// MCP Tools: list_due_sources / refresh_due_sources
//
// Scheduling lives in the CLIENT (a Claude Code scheduled task), not here. The
// server's job is to answer "what is stale?" and to run a batch that cannot
// overspend. That split is deliberate: a cron inside the product would spend a
// user's credits invisibly, whereas a scheduled task is something they created,
// can see, and can cancel.
//
// It also gives `Source.refreshSchedule` a purpose. Until now `daily`/`weekly`
// were stored on every source and read by nothing — a user could set "refresh
// daily", reasonably expect fresh videos, and get nothing, forever. These tools
// are what make that field true.
//
// THE SAFETY PROPERTY THAT MATTERS: an unattended run has nobody to confirm
// spend. Everything else in this codebase asks first (`spendsMoney: true`, "get
// an explicit yes"). That is impossible at 6am, so the ceiling replaces the
// prompt — `maxCredits` is required, has no default, and is enforced here
// rather than trusted to the caller. A single 50-video source costs 75 credits;
// two of them would drain a free-tier balance overnight.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { CREDIT_COSTS, creditBalance } from '../lib/credits.js';
import { enqueueRefreshJob, outstandingJobForSource, dispatchWorker } from '../lib/jobs.js';
import { resolveRefreshPlan } from '../lib/refresh-policy.js';
import { withNextSteps, apifyCostLabel } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Intervals are deliberately SHORTER than their names.
 *
 * A strict 24h clock and a fixed-time daily cron drift against each other, and
 * the drift silently eats runs. Observed: a source refreshed at 13:35 was not
 * due when the 12:29 task fired — 22h54m elapsed, 66 minutes short — and the
 * digest reported "nothing due" as though that were normal. Worse, once a run
 * does land, the next day's fire is almost exactly 24h later and the task
 * carries ~10 minutes of jitter, so roughly every other day would round the
 * wrong way and skip.
 *
 * 22h for daily is late enough that a source can never be refreshed twice in a
 * calendar day, and early enough that a fixed-time schedule always qualifies.
 * Same reasoning for weekly at 6.5 days.
 */
const INTERVAL_MS: Record<string, number> = {
  daily: 22 * 60 * 60_000,
  weekly: 6.5 * 24 * 60 * 60_000,
};

/** Same deadline as an interactive refresh — see src/tools/sources.ts. */
const REFRESH_JOB_DEADLINE_MS = 5 * 60_000;

interface DueSource {
  sourceId: string;
  query: string;
  platform: string;
  sourceType: string;
  refreshSchedule: string;
  videoLimit: number;
  /**
   * What the worker will ACTUALLY scrape (refresh-policy: bootstrap ≤20,
   * incremental ≤5) rather than the source's stored ceiling. Estimates and
   * pre-auths are sized from this; quoting `videoLimit` meant a legacy
   * 50-video source reserved 75 credits for a run that spends 8, and the
   * ceiling below then refused to queue sources the budget could easily cover.
   */
  plannedLimit: number;
  lastRefreshedAt: string | null;
  hoursOverdue: number | null;
  neverRefreshed: boolean;
  estimatedCredits: number;
  estimatedApify: string;
  hasOutstandingJob: boolean;
}

async function collectDue(
  workspaceId: string,
  includeManual: boolean,
  /**
   * Ignore the interval and treat every active scheduled source as due.
   *
   * For "run it now, I do not care that it ran this morning". The schedule is
   * for unattended runs; a human asking explicitly has already made the
   * decision the interval exists to make for them.
   */
  force = false,
): Promise<DueSource[]> {
  const sources = await db.source.findMany({
    where: {
      workspaceId,
      isActive: true,
      ...(includeManual ? {} : { refreshSchedule: { in: ['daily', 'weekly'] } }),
    },
    select: {
      id: true, query: true, platform: true, sourceType: true,
      refreshSchedule: true, videoLimit: true, lastRefreshedAt: true,
    },
  });

  const now = Date.now();
  const due: DueSource[] = [];

  for (const s of sources) {
    const interval = INTERVAL_MS[s.refreshSchedule];
    // A `manual` source has no interval; it is only ever due when explicitly
    // included, and then only if it has never been refreshed at all.
    const last = s.lastRefreshedAt ? s.lastRefreshedAt.getTime() : null;
    const overdueBy = last === null
      ? null
      : interval
        ? now - last - interval
        : null;

    const isDue = last === null || (interval != null && now - last >= interval);
    if (!isDue) continue;

    // Never enqueue a second job for a source already queued or running —
    // that is how a schedule turns into paying twice for the same scrape.
    const outstanding = await outstandingJobForSource(s.id);

    const plan = await resolveRefreshPlan({
      id: s.id,
      sourceType: s.sourceType,
      videoLimit: s.videoLimit,
      lastRefreshedAt: s.lastRefreshedAt,
    });

    due.push({
      sourceId: s.id,
      query: s.query,
      platform: s.platform,
      sourceType: s.sourceType,
      refreshSchedule: s.refreshSchedule,
      videoLimit: s.videoLimit,
      plannedLimit: plan.limit,
      lastRefreshedAt: s.lastRefreshedAt?.toISOString() ?? null,
      hoursOverdue: overdueBy != null ? Math.round(overdueBy / 3_600_000) : null,
      neverRefreshed: last === null,
      estimatedCredits: Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * plan.limit),
      estimatedApify: apifyCostLabel(plan.limit),
      hasOutstandingJob: Boolean(outstanding),
    });
  }

  // Most overdue first, and never-refreshed sources ahead of everything: a
  // source that has never run holds nothing at all, which is the worst state
  // to leave a tracked source in.
  due.sort((a, b) => {
    if (a.neverRefreshed !== b.neverRefreshed) return a.neverRefreshed ? -1 : 1;
    return (b.hoursOverdue ?? 0) - (a.hoursOverdue ?? 0);
  });

  return due;
}

export function registerScheduleTools(server: McpServer) {
  server.tool('list_due_sources',
    'List tracked sources whose refreshSchedule (daily/weekly) says they are overdue, with a cost estimate '
    + 'for each. FREE — reads only, spends nothing, enqueues nothing. Use this from a scheduled task to decide '
    + 'what to refresh, or any time to see what has gone stale.',
    {
      includeManual: z.boolean().default(false)
        .describe('Also include manual sources that have NEVER been refreshed (they hold no videos at all).'),
      force: z.boolean().default(false)
        .describe('Ignore the schedule interval and list every active scheduled source as due — for a manual '
          + '"run it now". Still free, still shows costs.'),
    },
    async ({ includeManual, force }) => {
      const workspace = await requireWorkspace();
      const due = await collectDue(workspace.id, includeManual, force);
      const balance = await creditBalance(workspace.id);

      const actionable = due.filter(d => !d.hasOutstandingJob);
      const totalCredits = actionable.reduce((a, d) => a + d.estimatedCredits, 0);

      // Forward projection, not just "can I afford today".
      //
      // A schedule burns credits on a fixed cadence, so the balance running out
      // is predictable well before it happens. Reporting it only when a call
      // fails means the user finds out mid-task, and an unattended run finds
      // out with nobody watching. Every input here is already known: the
      // sources, their cadence, and 1.5 credits per video.
      const scheduled = await db.source.findMany({
        where: { workspaceId: workspace.id, isActive: true, refreshSchedule: { in: ['daily', 'weekly'] } },
        select: { query: true, refreshSchedule: true, videoLimit: true },
      });

      let dailyBurn = 0;
      for (const s of scheduled) {
        const perRun = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * s.videoLimit);
        dailyBurn += s.refreshSchedule === 'daily' ? perRun : perRun / 7;
      }
      dailyBurn = Math.round(dailyBurn * 10) / 10;

      const runwayDays = dailyBurn > 0 ? Math.floor(balance.total / dailyBurn) : null;
      const topUpUrl = process.env.UPGRADE_URL ?? 'https://slashloop.dev/upgrade';
      const RUNWAY_WARN_DAYS = 7;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: due.length === 0
            ? 'Nothing is due. Every scheduled source is within its interval.'
            : `${due.length} source(s) due${due.length !== actionable.length ? `, ${due.length - actionable.length} already queued` : ''}.`,
          creditsAvailable: balance.total,
          estimatedCreditsToRefreshAll: totalCredits,
          affordable: totalCredits <= balance.total,
          projection: {
            scheduledSources: scheduled.length,
            creditsPerDay: dailyBurn,
            runwayDays,
            runsOutOn: runwayDays != null
              ? new Date(Date.now() + runwayDays * 86_400_000).toISOString().slice(0, 10)
              : null,
            breakdown: scheduled.map(s => ({
              query: s.query,
              cadence: s.refreshSchedule,
              videoLimit: s.videoLimit,
              creditsPerRun: Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * s.videoLimit),
            })),
            ...(runwayDays != null && runwayDays <= RUNWAY_WARN_DAYS ? {
              warning: `At the current schedule this workspace burns ~${dailyBurn} credits/day and has about `
                + `${runwayDays} day(s) left. Top up at ${topUpUrl}, or reduce a source's videoLimit — cost is `
                + '1.5 credits per video, so halving the limit halves the burn.',
              topUpUrl,
            } : {}),
          },
          due,
          note: 'Estimates assume each source returns its full videoLimit; the worker settles down to the '
            + 'actual number of videos returned, so real cost is usually lower. Sources with '
            + 'hasOutstandingJob are already queued and must not be enqueued again.',
        }, [
          actionable.length > 0 ? {
            label: `Refresh what is due (${actionable.length} source(s))`,
            tool: 'refresh_due_sources',
            args: { maxCredits: Math.min(totalCredits, balance.total) },
            cost: `up to ${Math.min(totalCredits, balance.total)} credits`,
            spendsMoney: true,
            why: 'maxCredits is a hard ceiling enforced server-side — sources that would exceed it are skipped '
              + 'and reported rather than partially run.',
          } : null,
        ]), null, 2) }],
      };
    });

  server.tool('refresh_due_sources',
    'Queue refreshes for every overdue source that fits inside a credit ceiling. Designed to be safe to run '
    + 'UNATTENDED from a scheduled task: maxCredits is required, enforced server-side, and sources that would '
    + 'exceed it are skipped rather than partially run. Sources with a job already queued are never '
    + 'double-enqueued. Credits are charged by the worker as each job runs, not up front.',
    {
      maxCredits: z.number().min(1)
        .describe('REQUIRED hard ceiling on total credits this run may commit. No default — an unattended '
          + 'run must state its budget. A 50-video source costs 75 credits.'),
      includeManual: z.boolean().default(false)
        .describe('Also refresh manual sources that have never been refreshed.'),
      dryRun: z.boolean().default(false)
        .describe('true = report the plan without enqueuing anything.'),
      force: z.boolean().default(false)
        .describe('Ignore the schedule interval and refresh every active scheduled source NOW. Use only when a '
          + 'human explicitly asked for an immediate run — never from an unattended schedule, where the interval '
          + 'is the thing preventing repeat spend. maxCredits still applies.'),
    },
    async ({ maxCredits, includeManual, dryRun, force }) => {
      const workspace = await requireWorkspace();
      const balance = await creditBalance(workspace.id);

      // The ceiling can never exceed what the workspace actually holds. A
      // scheduled task carrying a stale budget from last week must not be able
      // to authorise more than the balance.
      const ceiling = Math.min(maxCredits, balance.total);
      if (ceiling < 1) {
        const topUpUrl = process.env.UPGRADE_URL ?? 'https://slashloop.dev/upgrade';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'No credits available — nothing queued.',
            creditsAvailable: balance.total,
            requestedCeiling: maxCredits,
            topUpUrl,
            // A scheduled run that stops here reports to nobody in the moment,
            // so the recovery step has to be in the message itself.
            howToFix: `Top up at ${topUpUrl}, or lower the videoLimit on your scheduled sources — `
              + 'refresh costs 1.5 credits per video, so a 50-video source is 75 credits and a 10-video '
              + 'creator source is 15.',
          }, null, 2) }],
        };
      }

      const due = await collectDue(workspace.id, includeManual, force);

      const planned: Array<{ sourceId: string; query: string; estimatedCredits: number; videoLimit: number }> = [];
      const skipped: Array<{ sourceId: string; query: string; reason: string }> = [];
      let committed = 0;

      for (const d of due) {
        if (d.hasOutstandingJob) {
          skipped.push({ sourceId: d.sourceId, query: d.query, reason: 'already queued or running' });
          continue;
        }
        if (committed + d.estimatedCredits > ceiling) {
          skipped.push({
            sourceId: d.sourceId,
            query: d.query,
            reason: `would exceed the ${ceiling}-credit ceiling (needs ${d.estimatedCredits}, ${ceiling - committed} left)`,
          });
          continue;
        }
        planned.push({ sourceId: d.sourceId, query: d.query, estimatedCredits: d.estimatedCredits, videoLimit: d.plannedLimit });
        committed += d.estimatedCredits;
      }

      if (dryRun) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: `Dry run — would queue ${planned.length} refresh(es) for up to ${committed} credits.`,
            dryRun: true, ceiling, creditsAvailable: balance.total,
            planned, skipped,
          }, null, 2) }],
        };
      }

      const jobs: Array<{ sourceId: string; query: string; jobId: string }> = [];
      for (const p of planned) {
        const job = await enqueueRefreshJob({
          workspaceId: workspace.id,
          sourceId: p.sourceId,
          // plannedLimit, not the source's stored ceiling: the pre-auth must
          // match what the worker will actually scrape (refresh-policy).
          payload: { limitOverride: p.videoLimit },
          videoLimit: p.videoLimit,
          deadlineAt: new Date(Date.now() + REFRESH_JOB_DEADLINE_MS),
        });
        jobs.push({ sourceId: p.sourceId, query: p.query, jobId: job.id });
      }
      if (jobs.length > 0) await dispatchWorker('refresh');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Queued ${jobs.length} refresh(es), committing up to ${committed} of ${ceiling} credits.`,
          ceiling,
          creditsCommittedWorstCase: committed,
          creditsAvailableBefore: balance.total,
          queued: jobs,
          skipped,
          reportingNote:
            'Each refresh also queues a rescore, and it is the rescore that surfaces new `actual` scores. '
            + 'Do NOT summarise results immediately — the queue needs a minute or two. A digest written straight '
            + 'after this call will report stale scores. Wait, then call get_outlier_summary.',
        }, [
          jobs.length > 0 ? {
            label: 'Wait for the first refresh',
            tool: 'await_job',
            args: { jobId: jobs[0]!.jobId },
            why: 'Free. Only useful when a human is watching — an unattended run should simply return and let '
              + 'the queue drain.',
          } : null,
          jobs.length > 0 ? {
            label: 'Report what changed (after the queue drains)',
            tool: 'get_outlier_summary',
            why: 'Free. Lead with any new actual-score outliers; "N sources refreshed" on its own is noise.',
          } : null,
        ]), null, 2) }],
      };
    });
}
