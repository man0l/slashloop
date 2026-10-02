// ---------------------------------------------------------------------------
// MCP Tools: slideshow experiments — the agent-facing twin of the site's
// /experiments page (slashloop-site) and of api/experiments.ts.
//
// Thin wrappers only. Every tool resolves the workspace with
// resolveToolWorkspace() and then calls exactly what the REST endpoint calls:
// src/experiments/service.ts (createExperiment / estimate / mutate), the
// store's load/list/serialize, and src/experiments/delete.ts. Validation
// (zod Create/Plan/Generate/Retry/EditBrief), state-machine guards, the
// idempotency command log, the version CAS, the cap/wallet check
// (applyApprovedEstimate) and all credit movement stay in those modules —
// nothing here writes to the database.
//
// What this layer adds, all agent-safety plumbing the site does in its UI:
//   - one experiment per selected source video (site: ExperimentCreate.jsx);
//   - stable idempotency keys when the caller omits one, derived from the
//     request so a lost response + identical retry never duplicates or
//     double-spends;
//   - an explicit approvedCredits gate on every spending action: the tool
//     re-estimates and refuses if the fresh estimate exceeds what the user
//     approved (site: estimate panel + estimateBlockReason);
//   - a compact progress summary and nextSteps so an agent can drive the
//     draft → plan → review → generate lifecycle end to end.
// ---------------------------------------------------------------------------

import { z, ZodError } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { workspaceIdField, resolveToolWorkspace } from './workspace-param.js';
import { withNextSteps, type NextStep } from '../lib/next-steps.js';
import { CREDIT_COSTS, InsufficientCreditsError, insufficientCreditsPayload } from '../lib/credits.js';
import { createExperiment, estimate, mutate, fingerprint } from '../experiments/service.js';
import { load, list, serialize } from '../experiments/store.js';
import { deleteExperiment, deleteExperiments } from '../experiments/delete.js';
import { MAX_EXPERIMENT_CREDITS } from '../experiments/budget.js';
import {
  ExperimentError, Id, MAX_MANUAL_ATTEMPTS, SLIDE_FANOUT, VARIABLE_FIELDS, type Experiment, type InstructionsData,
} from '../experiments/schema.js';

// ---- dependencies ----------------------------------------------------------
// Injected like EngineDeps (src/experiments/engine.ts) so tests can drive the
// wrappers without module mocks; production always uses the real modules.

export interface ExperimentToolDeps {
  resolveWorkspace(args: { workspaceId?: string }): Promise<{ id: string }>;
  createExperiment: typeof createExperiment;
  estimate: typeof estimate;
  mutate: typeof mutate;
  load: typeof load;
  list: typeof list;
  serialize: typeof serialize;
  deleteExperiment: typeof deleteExperiment;
  deleteExperiments: typeof deleteExperiments;
}
export const defaultExperimentToolDeps: ExperimentToolDeps = {
  resolveWorkspace: resolveToolWorkspace, createExperiment, estimate, mutate, load, list, serialize, deleteExperiment, deleteExperiments,
};

// ---- helpers ---------------------------------------------------------------

/**
 * Edit-slideshow mode — the site's second wizard path, reproduced exactly.
 *
 * The site (src/ui/gallery.ts `buildPayload`, mode "edit") does not let the
 * caller write an experiment brief: it takes one slideshow, the new hook and
 * the new per-slide overlay copy, and assembles the rest itself. The goal
 * string is fixed, the only varied variable is the hook, mode is controlled,
 * there are exactly two variants and the cap is 100 credits — a hook A/B on a
 * deck whose images do not move.
 *
 * The overlay copy goes into `direction` as the planner's only brief, so the
 * per-slide lines are quoted in the wizard's own wording and order: slide 1 is
 * the tested hook, slides 2..N are supporting copy, and "(strip — no text)"
 * means render nothing at all, which is NOT the same as "leave the original".
 */
export const EDIT_GOAL = 'Edit the slideshow overlay text, keeping the same images.';
/** Two variants: the original hook and the replacement. */
export const EDIT_VARIANT_COUNT = 2;
/** Hard ceiling for an edit run, as on the site. */
export const EDIT_MAX_CREDITS = 100;

/**
 * The wizard's `direction` string for an edit run.
 *
 * Every entry is trimmed, like the wizard's `str()` helper: the copy is quoted
 * inside the sentence, so leading or trailing whitespace would be rendered as
 * part of the overlay text instead of being a typo in the request.
 */
export function editSlideDirection(hook: string, overlayTexts: string[]): string {
  const lines = [`Slide 1 (hook): "${hook.trim()}" (empty clears it too)`];
  overlayTexts.forEach((text, index) => {
    const trimmed = text.trim();
    lines.push(`Slide ${index + 2}: "${trimmed}"${trimmed ? '' : ' (strip — no text)'}`);
  });
  return 'Render the exact overlay texts. ' + lines.join(' ');
}

/** Edit mode is a single deck, so the "one experiment per source" loop is length 1 by definition. */
export function editInstructions(hook: string, overlayTexts: string[], language: string): InstructionsData {
  return {
    goal: EDIT_GOAL, brand: '', audience: '', language: language.trim() || 'English',
    direction: editSlideDirection(hook, overlayTexts),
    lockedConstraints: [], variables: ['hook'], mode: 'controlled',
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (payload: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** What an agent should do about the common refusal codes. */
const ERROR_HINTS: Record<string, string> = {
  not_draft: 'Planning already started (or finished). Call get_experiment to see the current state.',
  not_idle: 'Briefs can only be edited while the experiment is in review.',
  not_reviewable: 'Generation needs the experiment in review (or completed with draft variants left). Call get_experiment.',
  revision_conflict: 'The variant changed or is no longer a draft. Call get_experiment and use the latest revision.',
  idempotency_conflict: 'This idempotencyKey was already used for a different request. Use a new key for a different request.',
  concurrent_update: 'The experiment changed while saving (the background worker ticks it). Call get_experiment and retry.',
  active_experiment: 'Cancel the experiment (cancel_experiment) before deleting it.',
  not_retryable: 'Only failed or paused experiments can be retried.',
  nothing_to_retry: 'No failed jobs match. Call get_experiment to see job states.',
  retry_limit: `A job already used its ${MAX_MANUAL_ATTEMPTS} attempts and can no longer be retried.`,
  provider_outcome_unknown: 'A provider request is still in flight. Wait a moment and call get_experiment again.',
  insufficient_budget: 'The workspace wallet cannot cover this estimate. The user needs to add credits.',
  experiment_budget_exceeded: `This would take the experiment over the ${MAX_EXPERIMENT_CREDITS}-credit hard ceiling.`,
  video_not_slideshow: 'Only slideshows (or videos with a finished Recreate deck) can be experiment sources. show_gallery marks eligible cards.',
  video_not_found: 'That video is not in this workspace.',
  experiment_not_found: 'No experiment with that id in this workspace. list_experiments shows the ids.',
  locked_constraints: 'A brief must keep the experiment slide count and lockedConstraints exactly.',
};

export function experimentToolError(err: unknown): ToolResult {
  if (err instanceof InsufficientCreditsError) return text(insufficientCreditsPayload(err), true);
  if (err instanceof ExperimentError) {
    return text({ error: err.code, status: err.statusCode, message: err.message, hint: ERROR_HINTS[err.code] }, true);
  }
  if (err instanceof ZodError) return text({ error: 'invalid_request', issues: err.issues }, true);
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'Workspace not found.') return text({ error: 'workspace_not_found', message }, true);
  return text({ error: 'experiment_request_failed', message }, true);
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (err) { return experimentToolError(err); }
}

/** Deterministic idempotency key (matches schema Key: [a-zA-Z0-9_.:-], 8–128). */
export function derivedKey(scope: string, parts: unknown): string {
  return `mcp:${scope}:${fingerprint(parts).slice(0, 40)}`;
}

/**
 * Default per-experiment credit ceiling — the site's automatic cap
 * (ExperimentCreate.jsx): twice the one-source estimate, rounded up to 10,
 * at least 30. Priced from the server's CREDIT_COSTS / SLIDE_FANOUT. It is a
 * runaway guard only: an approved estimate may raise it (applyApprovedEstimate).
 */
export function defaultExperimentCap(variantCount: number, slideCount: number): number {
  const total = CREDIT_COSTS.analyzeVideo + 2 * CREDIT_COSTS.experimentPlanningCall
    + variantCount * slideCount * CREDIT_COSTS.experimentSlide * SLIDE_FANOUT;
  return Math.min(MAX_EXPERIMENT_CREDITS, Math.max(30, Math.ceil((total * 2) / 10) * 10));
}

const STATUS_HINTS: Record<string, string> = {
  draft: 'Draft — nothing spent yet. Next: estimate_experiment(stage="plan"), get the user\'s OK on totalCredits, then plan_experiment.',
  planning: 'Planning in the background: analyzing sources, writing the pattern report, then variant briefs. Check back with get_experiment in a minute or two — do not poll rapidly.',
  review: 'Variant briefs are ready. Review them (optionally edit with update_experiment_variant), then estimate_experiment(stage="generate", variantIds) and generate_experiment for the chosen variants.',
  generating: 'Rendering slide images in the background. Check back with get_experiment in a few minutes — do not poll rapidly.',
  completed: 'All selected variants are rendered. Image URLs are in progress.variants[].imageUrls.',
  failed: 'A step failed. See error / progress.retryableJobs, then estimate and retry_experiment.',
  paused: 'Paused (budget guard or provider outcome unknown). See error; retry_experiment resumes named jobs.',
  cancelled: 'Cancelled — terminal. delete_experiment removes it and its images.',
};

type JobCounts = Record<string, number>;
function countJobs(e: Experiment): Record<string, JobCounts> {
  const out: Record<string, JobCounts> = {};
  for (const t of e.tasks) {
    const row = (out[t.kind] ??= {});
    row[t.status] = (row[t.status] ?? 0) + 1;
  }
  return out;
}

/** Agent-sized view of where an experiment is. Reads only. */
export function experimentProgress(e: Experiment) {
  return {
    status: e.status,
    hint: STATUS_HINTS[e.status] ?? null,
    error: e.error,
    credits: { charged: e.creditsCharged, max: e.maxCredits },
    sources: { total: e.inputs.length, ready: e.inputs.filter(i => i.status === 'ready').length },
    reportReady: Boolean(e.report),
    jobs: countJobs(e),
    retryableJobs: e.tasks
      .filter(t => (t.status === 'failed' || t.status === 'unknown') && t.attempts < MAX_MANUAL_ATTEMPTS)
      .map(({ id, kind, target, index, status, error, attempts }) => ({ id, kind, target, index, status, error, attempts })),
    variants: e.variants.map((v, i) => {
      const done = v.slides.filter(s => s.status === 'done' && s.url);
      return {
        id: v.id,
        title: v.title,
        baseline: i === 0,
        status: v.status,
        revision: v.revision,
        changedVariables: v.changedVariables.map(c => c.name),
        jevScore: v.jev?.score ?? null,
        slidesDone: done.length,
        slidesTotal: v.slides.length || e.slideCount,
        imageUrls: done.map(s => s.url),
        error: v.error,
      };
    }),
  };
}

function listRow(e: Experiment) {
  return {
    id: e.id,
    status: e.status,
    goal: e.instructions.goal,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    videoIds: e.inputs.map(i => i.videoId),
    variantCount: e.variantCount,
    slideCount: e.slideCount,
    variants: e.variants.length,
    maxCredits: e.maxCredits,
    creditsCharged: e.creditsCharged,
    error: e.error,
  };
}

const credits = (n: number) => `${n} credits`;

function lifecycleSteps(e: Experiment): NextStep[] {
  const id = e.id;
  const draftVariants = e.variants.filter(v => v.status === 'draft');
  switch (e.status) {
    case 'draft':
      return [{ label: 'Price the planning stage', tool: 'estimate_experiment', args: { experimentId: id, stage: 'plan' }, why: 'Free. Planning spends credits; show the user the estimate first.' }];
    case 'planning':
    case 'generating':
      return [{ label: 'Check progress later', tool: 'get_experiment', args: { experimentId: id }, why: 'Free. The background worker advances the experiment; check back in a minute or two.' }];
    case 'review':
    case 'completed':
      return draftVariants.length
        ? [{ label: 'Price image generation for the reviewed variants', tool: 'estimate_experiment', args: { experimentId: id, stage: 'generate', variantIds: draftVariants.map(v => v.id) }, why: 'Free. Generation is the expensive step; the user approves the number first.' }]
        : [];
    case 'failed':
    case 'paused': {
      const jobs = experimentProgress(e).retryableJobs.map(j => j.id);
      return [{ label: 'Price a retry of the failed jobs', tool: 'estimate_experiment', args: jobs.length ? { experimentId: id, stage: 'generate', taskIds: jobs } : { experimentId: id, stage: e.report && e.variants.length ? 'generate' : 'plan' }, why: 'Free. Retries re-charge the retried jobs.' }];
    }
    case 'cancelled':
      return [{ label: 'Delete the cancelled experiment', tool: 'delete_experiment', args: { experimentId: id }, why: 'Free. Removes the record and its retained images.' }];
    default:
      return [];
  }
}

/**
 * Re-estimate, refuse when the fresh estimate exceeds what the user approved,
 * and hand that estimate back either way.
 *
 * Returning it on success matters: the price an agent approved is computed from
 * the state BEFORE the transition, and after planning that same state reads as
 * "nothing left to do". Dropping it would leave the only figure in the
 * conversation attached to a call that was refused.
 */
type Gate = { refusal: ToolResult | null; estimate: Awaited<ReturnType<ExperimentToolDeps['estimate']>> };
async function approvalGate(
  d: ExperimentToolDeps, e: Experiment, stage: 'plan' | 'generate', approvedCredits: number, variantIds?: string[], taskIds?: string[],
): Promise<Gate> {
  const estimate = await d.estimate(e, stage, variantIds, taskIds);
  if (estimate.totalCredits <= approvedCredits) return { refusal: null, estimate };
  return {
    estimate,
    refusal: text({
      error: 'estimate_exceeds_approval',
      message: `The current estimate is ${estimate.totalCredits} credits, above the ${approvedCredits} the user approved. Nothing was started. Show the user this estimate and ask again.`,
      estimate,
    }, true),
  };
}

function mutationResult(d: ExperimentToolDeps, e: Experiment, message: string, estimate?: Gate['estimate']): ToolResult {
  return text(withNextSteps({
    message, experiment: d.serialize(e), progress: experimentProgress(e),
    ...(estimate ? { estimate, estimateNote: 'Priced from the state before this call started. The worker settles against it job by job.' } : {}),
  }, lifecycleSteps(e)));
}

// ---- input schemas ---------------------------------------------------------
// Plain shapes (no transforms) so they render to JSON Schema for MCP clients;
// the service re-parses everything with the canonical schemas in schema.ts.

const experimentIdField = Id.describe('Experiment id (list_experiments / create_experiment).');
const idempotencyKeyField = z.string().min(8).max(120).regex(/^[a-zA-Z0-9_.:-]+$/).optional().describe(
  'Optional idempotency key. Omit it and a stable key is derived from the request, so repeating an identical call '
  + '(e.g. after a lost response) replays the first result instead of doing the work twice.',
);
const approvedCreditsField = z.number().int().min(0).describe(
  'The totalCredits from estimate_experiment that the user explicitly approved. If the fresh estimate is higher, '
  + 'nothing is started and the new estimate is returned.',
);
const VARIABLE_INPUT = z.enum([...VARIABLE_FIELDS, 'angle']);
const instructionsInput = z.object({
  goal: z.string().min(1).max(2000).describe('What the experiment should find out, e.g. "Find an opening hook that earns the first swipe".'),
  brand: z.string().max(2000).default(''),
  audience: z.string().max(2000).default(''),
  language: z.string().min(1).max(80).default('English'),
  direction: z.string().max(2000).default('').describe('Creative direction; add desired variable values here, e.g. "Desired variable values: a question versus a statement".'),
  lockedConstraints: z.array(z.string().min(1).max(2000)).max(20).default([]).describe('Rules every variant must keep, one per entry.'),
  variables: z.array(VARIABLE_INPUT).min(1).max(7).describe(
    'What to vary: hook, character, visualStyle, caption, cta (controlled mode), plus concept/"angle" and slides (exploration mode only).',
  ),
  mode: z.enum(['controlled', 'exploration']).default('controlled').describe(
    'controlled: each variant changes exactly one variable vs the baseline. exploration: variants may change several, and concept/slides are allowed.',
  ),
  varySupportingOverlays: z.boolean().optional().describe('Hook tests only (controlled, variables=["hook"]): variants may also retell slide 2+ overlay text while scenes stay identical.'),
});
const briefSlideInput = z.object({ role: z.string().min(1).max(80), scene: z.string().min(1).max(2000), overlayText: z.string().max(2000).default('') });
const briefInput = z.object({
  concept: z.string().min(1).max(2000), hook: z.string().min(1).max(2000), character: z.string().max(2000),
  visualStyle: z.string().min(1).max(2000), caption: z.string().max(2000), cta: z.string().max(2000),
  lockedConstraints: z.array(z.string().min(1).max(2000)).max(20),
  slides: z.array(briefSlideInput).min(3).max(8),
});

// ---- tools -----------------------------------------------------------------

const LIFECYCLE =
  'Experiment lifecycle: create_experiment (draft, free) → estimate_experiment stage=plan → user approves → plan_experiment '
  + '(background: source analysis, pattern report, variant briefs) → status "review" → optionally update_experiment_variant → '
  + 'estimate_experiment stage=generate → user approves → generate_experiment (background slide rendering) → "completed". '
  + 'Each spending step needs the user\'s explicit OK on the estimate; pass that number as approvedCredits.';

export function registerExperimentTools(server: McpServer, d: ExperimentToolDeps = defaultExperimentToolDeps) {
  // ---- list_experiments ----
  server.tool('list_experiments',
    'List slideshow experiments in this workspace, newest first (paginated). Free. Each row shows status, goal, source '
    + `videos and credits charged. Use get_experiment for briefs, jobs and images. ${LIFECYCLE}`,
    {
      workspaceId: workspaceIdField,
      limit: z.number().int().min(1).max(50).default(12),
      offset: z.number().int().min(0).default(0).describe('Pass nextOffset from the previous page.'),
    },
    { readOnlyHint: true },
    ({ workspaceId, limit, offset }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      // One extra row reveals whether another page exists (same as api/experiments.ts).
      const rows = await d.list(workspace.id, limit + 1, offset);
      const nextOffset = rows.length > limit ? offset + limit : null;
      return text({ experiments: rows.slice(0, limit).map(listRow), nextOffset });
    }));

  // ---- get_experiment ----
  server.tool('get_experiment',
    'Get one experiment: the full record (instructions, pattern report, variant briefs, slides, jobs) plus a compact '
    + '`progress` block — status with what to do next, job counts per stage, retryable jobs, and per-variant '
    + 'revision / slides done / image URLs. Free. Planning and generation run in the background; call this again '
    + 'after a minute or two rather than polling rapidly.',
    { workspaceId: workspaceIdField, experimentId: experimentIdField },
    { readOnlyHint: true },
    ({ workspaceId, experimentId }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      return text(withNextSteps({ experiment: d.serialize(e), progress: experimentProgress(e) }, lifecycleSteps(e)));
    }));

  // ---- create_experiment ----
  server.tool('create_experiment',
    'Create draft experiment(s) from Gallery slideshows. Free — a draft spends nothing. Two modes, matching the site\'s '
    + 'experiment wizard:\n'
    + '• mode "create" (default) — one experiment PER source video, because briefs never mix sources, so N videoIds '
    + 'create N drafts. Give `instructions`: what to vary, the goal, optional creative direction.\n'
    + '• mode "edit" — the site\'s "Edit slideshow" path: exactly ONE deck, the same images, new overlay copy. Pass `hook` '
    + '(slide 1) and `overlayTexts` (slides 2, 3, … in order; an empty string strips that slide\'s text) instead of '
    + '`instructions`; the tool assembles the same brief the site sends — fixed goal, hook as the only varied variable, '
    + 'controlled mode, 2 variants, a 100-credit cap — with the copy quoted per slide in the site\'s wording. '
    + 'The source deck\'s own slide count wins when it is known; pass slideCount only if you do not have it.\n'
    + 'Sources must be slideshows or videos with a finished Recreate deck (show_gallery marks them). '
    + `Credits: analysis ${CREDIT_COSTS.analyzeVideo}/source + ${CREDIT_COSTS.experimentPlanningCall} per planning call at plan time; `
    + `${CREDIT_COSTS.experimentSlide} per slide × ${SLIDE_FANOUT} candidates at generation. ${LIFECYCLE}`,
    {
      workspaceId: workspaceIdField,
      mode: z.enum(['edit', 'create']).default('create').describe(
        '"create" (default) = new variations from instructions. "edit" = keep the deck, replace the overlay text (one video).',
      ),
      videoIds: z.array(Id).min(1).max(20).describe('1–20 distinct Gallery video ids; one experiment per video. Edit mode takes exactly one.'),
      instructions: instructionsInput.optional().describe('CREATE mode. Required in create mode; not used in edit mode.'),
      hook: z.string().max(2000).optional().describe(
        'EDIT mode: the exact words for slide 1. May be empty if the change is a supporting slide\'s text instead.',
      ),
      overlayTexts: z.array(z.string().max(2000)).max(7).optional().describe(
        'EDIT mode: overlay text for slides 2, 3, … in order. Empty string = render no text on that slide.',
      ),
      language: z.string().trim().min(1).max(80).optional().describe('EDIT mode: output language for the copy (default English).'),
      variantCount: z.number().int().min(1).max(12).default(3).describe('CREATE mode: variants per experiment, including the baseline (1–12). Edit mode is always 2.'),
      slideCount: z.number().int().min(3).max(8).default(5).describe('Slides per variant (3–8); overridden by the source deck length when known.'),
      maxCredits: z.number().int().min(1).max(MAX_EXPERIMENT_CREDITS).optional().describe(
        'Per-experiment credit ceiling (runaway guard). Default: the site\'s automatic cap, 2× the estimate rounded up; 100 in edit mode. An approved estimate may raise it.',
      ),
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, mode, videoIds, instructions, hook, overlayTexts, language, variantCount, slideCount, maxCredits, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      if (new Set(videoIds).size !== videoIds.length) return text({ error: 'invalid_request', message: 'videoIds must be distinct.' }, true);
      if (mode === 'edit') {
        // One deck: the site's edit path never fans out, so a second id here
        // is a caller mistake rather than two experiments to build.
        if (videoIds.length !== 1) {
          return text({ error: 'invalid_request', message: 'mode "edit" works on exactly one slideshow — pass a single videoId, or use mode "create".' }, true);
        }
        if (!hook?.trim() && !(overlayTexts ?? []).some(t => t.trim())) {
          return text({ error: 'invalid_request', message: 'mode "edit" needs new copy: a hook for slide 1, or overlay text for a later slide.' }, true);
        }
      } else if (!instructions) {
        return text({ error: 'invalid_request', message: 'mode "create" needs instructions — a goal and at least one variable to test.' }, true);
      }
      const edit = mode === 'edit'
        ? {
          instructions: editInstructions(hook ?? '', overlayTexts ?? [], language ?? 'English'),
          variantCount: EDIT_VARIANT_COUNT,
          maxCredits: EDIT_MAX_CREDITS,
        }
        : { instructions: instructions!, variantCount, maxCredits: maxCredits ?? defaultExperimentCap(variantCount, slideCount) };
      const created: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];
      for (const [i, videoId] of videoIds.entries()) {
        const body = { workspaceId: workspace.id, videoIds: [videoId], ...edit, slideCount, maxCredits: edit.maxCredits };
        const key = idempotencyKey
          ? (videoIds.length === 1 ? idempotencyKey : `${idempotencyKey}:${i + 1}`)
          : derivedKey('create', body);
        try {
          const e = await d.createExperiment({ ...body, idempotencyKey: key });
          created.push({ ...listRow(e), idempotencyKey: key, planEstimate: await d.estimate(e, 'plan') });
        } catch (err) {
          const payload = JSON.parse(experimentToolError(err).content[0]!.text);
          failed.push({ videoId, ...payload });
        }
      }
      const payload = {
        message: `Created ${created.length} of ${videoIds.length} draft experiment${videoIds.length === 1 ? '' : 's'}. Nothing was charged.`,
        experiments: created,
        failed,
        note: 'Repeating this exact call returns the same drafts. To deliberately create a duplicate, pass a new idempotencyKey.',
      };
      return text(withNextSteps(payload, created.map(c => ({
        label: `Plan experiment ${String(c.id).slice(0, 8)}`,
        tool: 'plan_experiment',
        args: { experimentId: c.id, approvedCredits: (c.planEstimate as { totalCredits: number }).totalCredits },
        cost: credits((c.planEstimate as { totalCredits: number }).totalCredits),
        spendsMoney: true,
        why: 'Analyzes the source and writes the pattern report and variant briefs for review.',
      }))), created.length === 0);
    }));

  // ---- estimate_experiment ----
  server.tool('estimate_experiment',
    'Price the next step of an experiment before spending. Free. stage="plan" prices source analysis + planning (draft '
    + 'experiments); stage="generate" prices slide rendering for variantIds (default: all variants). Pass taskIds (from '
    + 'get_experiment progress.retryableJobs) to price retrying exactly those jobs. Returns totalCredits, the workspace '
    + 'wallet (workspaceCredits) and the experiment cap. Show totalCredits to the user and get an explicit yes; then pass '
    + 'it as approvedCredits to plan_experiment / generate_experiment / retry_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      stage: z.enum(['plan', 'generate']),
      variantIds: z.array(Id).min(1).max(12).optional().describe('generate stage only: the variants to render.'),
      taskIds: z.array(z.string().min(1)).min(1).max(150).optional().describe('Job ids to price a retry of.'),
    },
    { readOnlyHint: true },
    ({ workspaceId, experimentId, stage, variantIds, taskIds }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      const est = await d.estimate(e, stage, variantIds, taskIds);
      const affordable = est.totalCredits <= est.workspaceCredits;
      return text({
        estimate: est,
        affordable,
        note: affordable
          ? 'Ask the user to approve totalCredits before starting this step.'
          : 'Not enough credits in the workspace wallet for this step. The user needs to add credits first.',
      });
    }));

  // ---- plan_experiment ----
  server.tool('plan_experiment',
    'Start planning a DRAFT experiment: source analysis, pattern report, then variant briefs, all in the background. '
    + 'SPENDS CREDITS — call estimate_experiment(stage="plan") first and pass the approved totalCredits as approvedCredits. '
    + 'Afterwards status is "planning"; check with get_experiment until it reaches "review".',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      approvedCredits: approvedCreditsField,
      allowPartial: z.boolean().optional().describe('Continue if some source analyses fail (default false).'),
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, approvedCredits, allowPartial, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      const gate = await approvalGate(d, e, 'plan', approvedCredits);
      if (gate.refusal) return gate.refusal;
      const key = idempotencyKey ?? derivedKey('plan', { experimentId, allowPartial: allowPartial ?? false });
      const next = await d.mutate(workspace.id, experimentId, 'plan', { workspaceId: workspace.id, idempotencyKey: key, ...(allowPartial !== undefined ? { allowPartial } : {}) });
      return mutationResult(d, next, 'Planning started in the background.', gate.estimate);
    }));

  // ---- update_experiment_variant ----
  server.tool('update_experiment_variant',
    'Edit one variant\'s brief while the experiment is in "review" and the variant is still a draft. Free. Pass the '
    + 'variant\'s current revision (get_experiment) — a stale revision is refused, never overwritten. The brief must '
    + 'keep the experiment\'s slide count and lockedConstraints, and must still differ from the baseline only in the '
    + 'experiment\'s chosen variables. Returns the variant\'s new revision; use it when calling generate_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      variantId: Id.describe('Variant id from get_experiment.'),
      revision: z.number().int().positive().describe('The variant\'s current revision.'),
      brief: briefInput.describe('The complete edited brief (all fields, not a patch).'),
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, variantId, revision, brief }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const next = await d.mutate(workspace.id, experimentId, 'edit', { workspaceId: workspace.id, revision, brief }, variantId);
      const v = next.variants.find(x => x.id === variantId);
      return mutationResult(d, next, `Brief saved. Variant is now at revision ${v?.revision ?? '?'}.`);
    }));

  // ---- generate_experiment ----
  server.tool('generate_experiment',
    'Render slide images for reviewed variants (status "review", or "completed" with draft variants left). SPENDS CREDITS — '
    + `${CREDIT_COSTS.experimentSlide} per slide × ${SLIDE_FANOUT} candidates. Call estimate_experiment(stage="generate", variantIds) `
    + 'first and pass the approved totalCredits. Pass each variant with its CURRENT revision (get_experiment); the brief '
    + 'is frozen at that revision. Rendering runs in the background; check with get_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      variants: z.array(z.object({ id: Id, revision: z.number().int().positive() })).min(1).max(12),
      approvedCredits: approvedCreditsField,
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, variants, approvedCredits, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      const gate = await approvalGate(d, e, 'generate', approvedCredits, variants.map(v => v.id));
      if (gate.refusal) return gate.refusal;
      const key = idempotencyKey ?? derivedKey('generate', { experimentId, variants });
      const next = await d.mutate(workspace.id, experimentId, 'generate', { workspaceId: workspace.id, idempotencyKey: key, variants });
      return mutationResult(d, next, `Rendering started for ${variants.length} variant${variants.length === 1 ? '' : 's'}.`, gate.estimate);
    }));

  // ---- retry_experiment ----
  server.tool('retry_experiment',
    'Retry a failed or paused experiment. SPENDS CREDITS (retried jobs are charged again). Scope it with taskIds (from '
    + 'get_experiment progress.retryableJobs) or variantIds (failed slides of those variants); with neither, every failed '
    + 'job is retried and `stage` says how to price it (plan while no briefs exist yet, else generate). Call '
    + 'estimate_experiment with the same scope first and pass the approved totalCredits. Completed images are kept.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      taskIds: z.array(z.string().min(1)).min(1).max(150).optional(),
      variantIds: z.array(Id).min(1).max(12).optional(),
      stage: z.enum(['plan', 'generate']).optional().describe('Pricing stage for a blanket retry (no taskIds/variantIds).'),
      approvedCredits: approvedCreditsField,
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, taskIds, variantIds, stage, approvedCredits, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      // Same pricing the site's approval panel uses for each retry scope.
      const gate = taskIds
        ? await approvalGate(d, e, 'generate', approvedCredits, undefined, taskIds)
        : variantIds
          ? await approvalGate(d, e, 'generate', approvedCredits, variantIds)
          : await approvalGate(d, e, stage ?? (e.report && e.variants.length ? 'generate' : 'plan'), approvedCredits);
      if (gate.refusal) return gate.refusal;
      // Attempts only move when a job actually ran again, so an identical call
      // after a lost response replays; a genuine second retry gets a new key.
      const attempts = e.tasks.reduce((n, t) => n + t.attempts, 0);
      const key = idempotencyKey ?? derivedKey('retry', { experimentId, taskIds, variantIds, attempts });
      const next = await d.mutate(workspace.id, experimentId, 'retry', {
        workspaceId: workspace.id, idempotencyKey: key,
        ...(taskIds ? { taskIds } : {}), ...(variantIds ? { variantIds } : {}),
      });
      return mutationResult(d, next, 'Retry queued in the background.', gate.estimate);
    }));

  // ---- cancel_experiment ----
  server.tool('cancel_experiment',
    'Cancel an experiment. Free; stops further background work (in-flight provider calls may still settle). Cancelled '
    + 'is terminal — it cannot be resumed. Cancel a planning/generating experiment before deleting it.',
    { workspaceId: workspaceIdField, experimentId: experimentIdField, idempotencyKey: idempotencyKeyField },
    { readOnlyHint: false, destructiveHint: true },
    ({ workspaceId, experimentId, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const key = idempotencyKey ?? derivedKey('cancel', { experimentId });
      const next = await d.mutate(workspace.id, experimentId, 'cancel', { workspaceId: workspace.id, idempotencyKey: key });
      return mutationResult(d, next, 'Experiment cancelled.');
    }));

  // ---- delete_experiment ----
  server.tool('delete_experiment',
    'Permanently delete one experiment (experimentId) or several (experimentIds, best-effort per id) together with '
    + 'their generated images. Free, irreversible — confirm with the user first. Experiments that are planning or '
    + 'generating are refused: cancel_experiment them first.',
    {
      workspaceId: workspaceIdField,
      experimentId: Id.optional().describe('Delete a single experiment.'),
      experimentIds: z.array(Id).min(1).max(100).optional().describe('Bulk delete; per-id failures are reported.'),
    },
    { readOnlyHint: false, destructiveHint: true },
    ({ workspaceId, experimentId, experimentIds }) => guarded(async () => {
      if (!!experimentId === !!experimentIds) {
        return text({ error: 'invalid_request', message: 'Pass exactly one of experimentId or experimentIds.' }, true);
      }
      const workspace = await d.resolveWorkspace({ workspaceId });
      if (experimentId) return text({ ...(await d.deleteExperiment(workspace.id, experimentId)), experimentId });
      return text(await d.deleteExperiments(workspace.id, experimentIds!));
    }));
}
