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
import { workspaceIdField, resolveToolWorkspace } from './workspace-param.js';
import { withNextSteps } from '../lib/next-steps.js';
import { findByTaskId } from '../experiments/store.js';
import type { Task } from '../experiments/schema.js';
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

type MediaJobRow = NonNullable<Awaited<ReturnType<typeof db.mediaJob.findFirst>>>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const json = (payload: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export interface JobToolDeps {
  resolveWorkspace(args: { workspaceId?: string }): Promise<{ id: string }>;
  findMediaJob(workspaceId: string, jobId: string): Promise<MediaJobRow | null>;
  findExperimentTask(workspaceId: string, jobId: string): Promise<{ experimentId: string; task: Task } | null>;
}
export const defaultJobToolDeps: JobToolDeps = {
  resolveWorkspace: resolveToolWorkspace,
  findMediaJob: (workspaceId, jobId) => db.mediaJob.findFirst({ where: { id: jobId, workspaceId } }),
  async findExperimentTask(workspaceId, jobId) {
    const e = await findByTaskId(workspaceId, jobId);
    const task = e?.tasks.find(t => t.id === jobId);
    return e && task ? { experimentId: e.id, task } : null;
  },
};

const NOT_A_MEDIA_JOB = 'These tools only cover refresh and analyze jobs (ids from refresh_source or analyze_video). '
  + 'Experiment jobs are tracked through get_experiment.';

/** Answer for an id that is no MediaJob: an experiment task gets its status plus a redirect, anything else a precise "not found". */
async function notAMediaJob(d: JobToolDeps, workspaceId: string, jobId: string): Promise<ToolResult> {
  const hit = await d.findExperimentTask(workspaceId, jobId);
  if (!hit) {
    return json({ error: `No refresh/analyze job with this id in this workspace. ${NOT_A_MEDIA_JOB}`, jobId, shouldKeepPolling: false }, true);
  }
  const { experimentId, task } = hit;
  return json(withNextSteps({
    jobId,
    jobType: 'experiment',
    experimentId,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    error: task.error ?? null,
    nextAttemptAt: task.nextAttemptAt ? new Date(task.nextAttemptAt).toISOString() : null,
    shouldKeepPolling: false,
    message: `This is an experiment job, not a refresh/analyze job. The experiment's background worker runs it and retries on its own; `
      + `await_job cannot wait for it. Use get_experiment(experimentId="${experimentId}") for progress.`,
  }, [{
    label: 'Check the experiment',
    tool: 'get_experiment',
    args: { experimentId },
    why: 'Free. Shows this job under progress.jobs (with retry error and next attempt time) and what to do next. Do not poll rapidly.',
  }]));
}

export function registerJobTools(server: McpServer, d: JobToolDeps = defaultJobToolDeps) {
  server.tool('await_job',
    'Wait for a queued job to finish. Blocks server-side for up to ~25s and returns as soon as the job '
    + 'reaches done or failed. Free. Call it again ONLY while the response says shouldKeepPolling: true — '
    + 'stop immediately when it is false, which also happens once the job passes its deadline. '
    + `Never call it more than ${MAX_POLLS_HINT} times for one job. Only for refresh/analyze jobs; experiment jobs are tracked with get_experiment.`,
    {
      workspaceId: workspaceIdField,
      jobId: z.string().describe('Job id returned by refresh_source (async) or analyze_video. NOT an experiment job id (experiment.jobs[].id from plan_experiment / get_experiment) — track those with get_experiment.'),
      maxWaitMs: z.number().min(1000).max(MAX_WAIT_MS).default(DEFAULT_WAIT_MS)
        .describe(`How long to block server-side this call (default ${DEFAULT_WAIT_MS}ms, max ${MAX_WAIT_MS}ms).`),
    },
    async ({ workspaceId, jobId, maxWaitMs }) => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const started = Date.now();

      let job = await d.findMediaJob(workspace.id, jobId);
      if (!job) return notAMediaJob(d, workspace.id, jobId);

      while (
        !TERMINAL.has(job.status)
        && Date.now() - started < maxWaitMs
        && !(job.deadlineAt && new Date() > job.deadlineAt)
      ) {
        await sleep(POLL_INTERVAL_MS);
        job = await d.findMediaJob(workspace.id, jobId);
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
    'Read a refresh/analyze job\'s current state without waiting. Free. Use for a one-off check; use await_job when you '
    + 'actually intend to wait for the result. Not for experiment job ids (experiment.jobs[].id) — use get_experiment for those.',
    {
      workspaceId: workspaceIdField,
      jobId: z.string().describe('Job id returned by refresh_source (async) or analyze_video. NOT an experiment job id — use get_experiment.'),
    },
    async ({ workspaceId, jobId }) => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const job = await d.findMediaJob(workspace.id, jobId);
      if (!job) return notAMediaJob(d, workspace.id, jobId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          jobId, ...describe(job), sourceId: job.sourceId, videoId: job.videoId,
        }, null, 2) }],
      };
    });
}
