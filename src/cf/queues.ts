// ===========================================================================
// Phase 2b path (a) — Cloudflare-native compute: Queues routing stub.
// NOT WIRED IN. Nothing imports this module (not worker.ts, not router.ts).
// It exists so the Queues follow-up merges conflict-free; the retained-VPS
// D1 loop in src/worker/index.ts is untouched and remains the only drain.
//
// Design (full version in docs/compute-target.md):
//   • The D1 MediaJob table stays the queue of record — enqueue paths,
//     claimNextJob, and the retry/refund policy in src/worker/process-job.ts
//     do NOT change. Queues carry wake-up messages ({ jobId, kind }), never
//     job state, so there is no second state machine to reconcile.
//   • This consumer runs on the Worker: LIGHT kinds (thumb, rescore — no
//     browser, no native modules, seconds of CPU) are processed inline via
//     processClaimedJob with a deadline; HEAVY kinds
//     (fetch/analyze/refresh/discover — 60–170s scrapes,
//     Playwright/impit/xbogus, residential proxy) are forwarded to the
//     Workflow in ./workflows.js, which runs them in a Container.
//   • No static import of the processor here on purpose: even a light-kind
//     inline path must dynamic-import it (Workers bundle safety —
//     Playwright/impit/xbogus/warm-signer must never enter the import graph;
//     see wrangler.jsonc `alias` + src/lib/scrapers/index.ts).
// ===========================================================================

/** Job kinds this router knows. Heavy kinds never execute on the Worker. */
export const LIGHT_KINDS = ['thumb', 'rescore'] as const;
export const HEAVY_KINDS = ['fetch', 'analyze', 'refresh', 'discover'] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];
export type HeavyKind = (typeof HEAVY_KINDS)[number];

export function isHeavyKind(kind: string): kind is HeavyKind {
  return (HEAVY_KINDS as readonly string[]).includes(kind);
}

/** Wake-up message the producer sends per enqueued MediaJob row. */
export interface JobWakeMessage {
  jobId: string;
  kind: string;
  workspaceId: string;
  /** Enqueue timestamp — the consumer drops wake-ups older than the job's terminal state. */
  enqueuedAt: number;
}

/** Minimal Queue producer shape (structural — no @cloudflare/workers-types dep). */
export interface QueueProducer<T> {
  send(message: T): Promise<void>;
}

/**
 * Producer: call AFTER the MediaJob row is committed (enqueue*Job resolves).
 * Fire-and-forget wake-up — if the send fails, the Container's poll loop in
 * ./compute-containers.js still claims the row; Queues are a latency
 * optimization, not the queue of record.
 */
export async function publishJobWake(
  queue: QueueProducer<JobWakeMessage>,
  msg: JobWakeMessage,
): Promise<void> {
  await queue.send(msg);
}

/** What the consumer decided for one wake-up (observability, not state). */
export type WakeDisposition =
  | { action: 'process-inline'; kind: LightKind }
  | { action: 'forward-to-workflow'; kind: HeavyKind }
  | { action: 'drop'; reason: string };

/**
 * Pure routing — no I/O, trivially unit-testable. Heavy kinds go to the
 * Workflow (Container); light kinds stay on the Worker; unknown kinds drop
 * (the row itself is unaffected and the existing sweeps still recover it).
 */
export function routeWake(msg: JobWakeMessage): WakeDisposition {
  if (isHeavyKind(msg.kind)) return { action: 'forward-to-workflow', kind: msg.kind };
  if ((LIGHT_KINDS as readonly string[]).includes(msg.kind)) {
    return { action: 'process-inline', kind: msg.kind as LightKind };
  }
  return { action: 'drop', reason: `unknown kind "${msg.kind}"` };
}

/**
 * Consumer sketch (runs on the Worker, inside queue(...).consume):
 *
 *   for (const msg of batch.messages) {
 *     const route = routeWake(msg.body);
 *     if (route.action === 'forward-to-workflow') {
 *       await env.JOB_WORKFLOW.create({ params: { jobId, kind } });
 *       msg.ack();
 *     } else if (route.action === 'process-inline') {
 *       // Claim via claimNextJob (atomic UPDATE..RETURNING on D1), then
 *       // `await import('../worker/process-job.js')` DYNAMICALLY and call
 *       // processClaimedJob(job, { deadlineMs, refreshRequiresMs }) —
 *       // the shared policy stays the single owner. Static import is
 *       // forbidden here (bundle safety, see header).
 *       msg.ack();
 *     } else { msg.ack(); } // drop: row untouched, sweeps own recovery
 *   }
 */
export const __consumerSketch = 'see docblock above';
