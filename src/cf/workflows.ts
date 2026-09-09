// ===========================================================================
// Phase 2b path (a) — Cloudflare-native compute: Workflow stub.
// NOT WIRED IN. Nothing imports this module. See ./queues.js (producer/
// consumer) and ./compute-containers.js (where the work actually runs).
//
// Why a Workflow between the Queue and the Container: heavy kinds run
// 60–170s (refresh batch scrape + fan-out, OpenRouter video analysis) with
// per-kind retries. A Queue consumer alone has no durable sleep/retry across
// those timescales; the Workflow owns the retry policy (re-queue the MediaJob
// row via yieldJob/failJob semantics already in src/lib/jobs.ts) and the
// Container call is one step with a timeout per kind (jobTimeoutMs).
// ===========================================================================

import type { HeavyKind } from './queues.js';

/** Params the Queue consumer passes to Workflow.create(). */
export interface HeavyJobWorkflowParams {
  jobId: string;
  kind: HeavyKind;
  /** Max attempts at the Workflow level — mirrors MAX_ATTEMPTS in jobs.ts. */
  maxAttempts?: number;
}

/** Minimal Workflow binding shape (structural — no workers-types dep). */
export interface WorkflowBinding<P> {
  create(opts: { id: string; params: P }): Promise<{ id: string }>;
}

/** Per-kind Container step timeouts — must match jobTimeoutMs(kind). */
export function workflowStepTimeoutMs(kind: HeavyKind): number {
  // fetch 90s / analyze = OPENROUTER_VIDEO_TIMEOUT_MS + 30s / refresh+discover 120s.
  if (kind === 'fetch') return 90_000;
  if (kind === 'analyze') {
    const video = Number(process.env.OPENROUTER_VIDEO_TIMEOUT_MS ?? 300_000);
    return (Number.isFinite(video) && video > 0 ? video : 300_000) + 30_000;
  }
  return 120_000;
}

/**
 * Workflow step sketch (Cloudflare Workflows syntax, for the follow-up):
 *
 *   export class HeavyJobWorkflow extends WorkflowEntrypoint<Env, Params> {
 *     async run(event, step) {
 *       const { jobId, kind } = event.params;
 *       // ONE step: the Container claims the row itself (atomic
 *       // UPDATE..RETURNING over D1-over-HTTP — no double-claim with the VPS
 *       // loop during the transition) and runs processClaimedJob VERBATIM.
 *       await step.do('run in container', {
 *         timeout: workflowStepTimeoutMs(kind),
 *         retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
 *       }, async () => {
 *         await env.HEAVY_CONTAINER.run(jobId, kind); // container binding
 *       });
 *       // No result parsing here: the row's status (done/failed/queued via
 *       // yield) IS the result. Retries re-enter this step; exhaustion leaves
 *       // the row for reclaimStuckJobs, exactly like a dead VPS worker today.
 *     }
 *   }
 */
export const __workflowSketch = 'see docblock above';
