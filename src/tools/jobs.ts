// ---------------------------------------------------------------------------
// MCP Tools: await_job / get_job_status — waiting on queued work.
//
// The waiting is done SERVER-side, and the decision to stop waiting is made
// server-side too. Both matter:
//
// 1. An agent has no sleep(). Told to "poll every 5 seconds" it will simply
//    call as fast as the round-trip allows. Blocking inside one tool call for
//    ~25s and returning early on a terminal state turns a 90-second scrape into
//    three calls instead of thirty.
//
// 2. A budget the agent is asked to track is a budget it can lose track of over
//    a long conversation. So `shouldKeepPolling` is computed here from the
//    job's own deadlineAt. Past the deadline the tool cannot say `true`, and a
//    caller that ignores the flag still terminates.
//
// The 25s ceiling is deliberate: comfortably inside both the 60s function cap
// and the MCP client's request timeout. A 180s tool timeout was observed in
// this project when a scrape ran inline; nothing here may approach that.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { withNextSteps } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const TERMINAL = new Set(['done', 'failed']);
const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;

/** Hard cap on how many times a caller should ever re-enter await_job. */
const MAX_POLLS_HINT = 12;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function describe(job: {
  status: string; kind: string; attempts: number; lastError: string | null;
  deadlineAt: Date | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
}) {
  return {
    status: job.status,
    kind: job.kind,
    attempts: job.attempts,
    lastError: job.lastError,
    queuedAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
  };
}

export function registerJobTools(server: McpServer) {
  server.tool('await_job',
    'Wait for a queued job to finish. Blocks server-side for up to ~25s and returns as soon as the job '
    + 'reaches done or failed. Free. Call it again ONLY while the response says shouldKeepPolling: true — '
    + 'stop immediately when it is false, which also happens once the job passes its deadline. '
    + `Never call it more than ${MAX_POLLS_HINT} times for one job.`,
    {
      jobId: z.string().describe('Job id returned by refresh_source (async) or analyze_video.'),
      maxWaitMs: z.number().min(1000).max(MAX_WAIT_MS).default(DEFAULT_WAIT_MS)
        .describe(`How long to block server-side this call (default ${DEFAULT_WAIT_MS}ms, max ${MAX_WAIT_MS}ms).`),
    },
    async ({ jobId, maxWaitMs }) => {
      const workspace = await requireWorkspace();
      const started = Date.now();

      let job = await db.mediaJob.findFirst({ where: { id: jobId, workspaceId: workspace.id } });
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Job not found in this workspace.', jobId, shouldKeepPolling: false,
          }, null, 2) }],
          isError: true,
        };
      }

      while (
        !TERMINAL.has(job.status)
        && Date.now() - started < maxWaitMs
        && !(job.deadlineAt && new Date() > job.deadlineAt)
      ) {
        await sleep(POLL_INTERVAL_MS);
        job = await db.mediaJob.findFirst({ where: { id: jobId, workspaceId: workspace.id } });
        if (!job) break;
      }

      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Job disappeared while waiting.', jobId, shouldKeepPolling: false,
          }, null, 2) }],
          isError: true,
        };
      }

      const terminal = TERMINAL.has(job.status);
      const pastDeadline = Boolean(job.deadlineAt && new Date() > job.deadlineAt);
      const shouldKeepPolling = !terminal && !pastDeadline;

      // A failed job must say whether the user paid. Making them go and check
      // get_usage to find out is how a refund quietly goes unnoticed.
      let refundNote: string | undefined;
      if (job.status === 'failed') {
        refundNote = job.opId
          ? 'Credits pre-authorised for this job are refunded when it fails terminally (idempotent on refId). '
            + 'Confirm with get_usage if the balance matters.'
          : 'This job kind settles its own credits inside the worker, so a failure before the debit costs nothing.';
      }

      const payload = {
        jobId,
        ...describe(job),
        elapsedMsThisCall: Date.now() - started,
        shouldKeepPolling,
        stopReason: terminal
          ? `Job is ${job.status}.`
          : pastDeadline
            ? 'Deadline passed. The job may still be running — report that and stop waiting.'
            : undefined,
        refundNote,
        pollingContract:
          `Call await_job again only while shouldKeepPolling is true. Stop the moment it is false. `
          + `Hard ceiling ${MAX_POLLS_HINT} calls per job.`,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps(payload, [
          shouldKeepPolling ? {
            label: 'Keep waiting',
            tool: 'await_job',
            args: { jobId },
            why: 'Still running and inside its deadline. Free.',
          } : null,
          job.status === 'done' && job.kind === 'refresh' ? {
            label: 'See the updated scores',
            tool: 'get_outlier_summary',
            why: 'Free. The refresh rescored any other sources holding this creator\'s videos.',
          } : null,
          job.status === 'failed' ? {
            label: 'Check what it cost',
            tool: 'get_usage',
            why: 'Free. Confirms whether the failed attempt was refunded.',
          } : null,
        ]), null, 2) }],
      };
    });

  server.tool('get_job_status',
    'Read a job\'s current state without waiting. Free. Use for a one-off check; use await_job when you '
    + 'actually intend to wait for the result.',
    { jobId: z.string() },
    async ({ jobId }) => {
      const workspace = await requireWorkspace();
      const job = await db.mediaJob.findFirst({ where: { id: jobId, workspaceId: workspace.id } });
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found.', jobId }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          jobId, ...describe(job), sourceId: job.sourceId, videoId: job.videoId,
        }, null, 2) }],
      };
    });
}
