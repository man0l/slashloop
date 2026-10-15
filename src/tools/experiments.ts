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
import { createExperiment, dedupeSourcePosts, estimate, mutate, fingerprint, estimateFeedback } from '../experiments/service.js';
import { SOURCE_FORMATS } from '../experiments/source-format.js';
import { ARC_LEVELS } from '../experiments/resolved-contract.js';
import { load, list, serialize, testSummary } from '../experiments/store.js';
import { deleteExperiment, deleteExperiments } from '../experiments/delete.js';
import { MAX_EXPERIMENT_CREDITS } from '../experiments/budget.js';
import {
  CopyOverrides, DIRECTION_MAX, ExperimentError, SCENE_MAX, FEEDBACK_MAX, Id, Instructions, MAX_MANUAL_ATTEMPTS, normalizeTestKey, slideFanout, VARIABLE_FIELDS, type Experiment, type InstructionsData,
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
  /** Optional so a caller that supplies its own deps keeps the old pass-through. */
  dedupeSourcePosts?: typeof dedupeSourcePosts;
  /** Optional for the same reason; submit_experiment_feedback refuses without it. */
  estimateFeedback?: typeof estimateFeedback;
  /** Optional for the same reason; list_experiments omits the `test` block without it. */
  testSummary?: typeof testSummary;
}
export const defaultExperimentToolDeps: ExperimentToolDeps = {
  resolveWorkspace: resolveToolWorkspace, createExperiment, dedupeSourcePosts, estimate, estimateFeedback, mutate, load, list, serialize, deleteExperiment, deleteExperiments, testSummary,
};

// ---- helpers ---------------------------------------------------------------

/**
 * Edit-slideshow mode — the site's second wizard path, reproduced exactly.
 *
 * The site (src/ui/gallery.ts `buildPayload`, mode "edit") does not let the
 * caller write an experiment brief: it takes one slideshow plus replacement
 * overlay copy or a character casting direction, and assembles the rest itself. The goal
 * string is fixed, the varied variable is hook (copy) or character, mode is controlled,
 * there are exactly two variants and the cap is 100 credits. Copy edits lock
 * the images; character edits lock copy, style, setting and story.
 *
 * `copyOverrides` carries the exact requested copy as structured values; the
 * `direction` prose below is only the planner's hint, quoted in the wizard's own
 * wording and order (slide 1 is the tested hook, slides 2..N are supporting
 * copy, and "(strip — no text)" means render nothing at all). SLA-431: prose
 * alone lost the requested copy, so the two carriers must agree — an omitted
 * slide is described as unchanged, never as cleared.
 */
export const EDIT_GOAL = 'Edit the slideshow overlay text, keeping the same images.';
export const EDIT_CHARACTER_GOAL = 'Edit the slideshow character, keeping the same overlay text, style, setting and story.';
export const EDIT_CHARACTER_MAX = 1000;
export const EDIT_SCENE_GOAL = 'Edit the slideshow scene, keeping the same person, medium, lighting, camera and overlay text.';
/** The scenes as one sentence for the planner; the exact per-slide values travel in `sceneOverrides`. */
export function editSceneDirection(scenes: readonly string[]): string {
  const said = scenes.length === 1 ? scenes[0]!.trim() : scenes.map((x, i) => `slide ${i + 1}: ${x.trim()}`).join('; ');
  return ('Scene: ' + said).slice(0, 1500) + '. Change only the setting, props and action; keep the same person, medium, lighting, camera and overlay text.';
}
export function editCharacterDirection(character: string): string {
  return 'Character: ' + character.trim() + '. Keep the same overlay text, style, setting and story.';
}
/** Two variants: the original and the replacement. */
export const EDIT_VARIANT_COUNT = 2;
/** Per-value copy ceiling for an edit request, matching the site's own input
 *  maxlength. It bounds the quoted direction: hook + 7 overlays at this size,
 *  plus the per-slide framing, stays under Instructions.direction's 2000-char
 *  cap. The wizard and this tool are two producers of that prose and must
 *  agree, so the bound lives on both. */
export const EDIT_COPY_MAX = 200;
/** Hard ceiling for an edit run, as on the site. */
export const EDIT_MAX_CREDITS = 100;

/**
 * The wizard's `direction` string for an edit run.
 *
 * Every entry is trimmed, like the wizard's `str()` helper: the copy is quoted
 * inside the sentence, so leading or trailing whitespace would be rendered as
 * part of the overlay text instead of being a typo in the request.
 */
export function editSlideDirection(hook: string | undefined, overlayTexts: Array<string | null>): string {
  // An omitted hook must not be described as a cleared slide: the structured
  // carrier treats an omitted index as "unchanged", and prose that says the
  // opposite would instruct the planner to blank a slide the user never touched.
  const lines = [hook === undefined
    ? 'Slide 1 (hook): unchanged — no new hook was requested'
    : `Slide 1 (hook): "${hook.trim()}" (empty clears it too)`];
  overlayTexts.forEach((text, index) => {
    // null is an omitted slide: it is described as unchanged, never as cleared.
    if (text === null) { lines.push(`Slide ${index + 2}: unchanged — no new text was requested`); return; }
    const trimmed = text.trim();
    lines.push(`Slide ${index + 2}: "${trimmed}"${trimmed ? '' : ' (strip — no text)'}`);
  });
  return 'Render the exact overlay texts. ' + lines.join(' ');
}

/** Edit mode is a single deck, so the "one experiment per source" loop is length 1 by definition. */
export function editInstructions(hook: string | undefined, overlayTexts: Array<string | null>, language: string,
  options: { variables?: Array<'hook' | 'character' | 'scene'>; character?: string; scene?: string | string[]; overlayMode?: 'model' | 'script' } = {}): InstructionsData {
  const variables = options.variables ?? [options.scene !== undefined ? 'scene' : options.character !== undefined ? 'character' : 'hook'];
  if (variables.length !== 1) throw new ExperimentError(400, 'invalid_request', 'Edit mode tests exactly one variable: hook, character or scene. Use create mode for several variables.');
  if (variables[0] === 'scene') {
    const scenes = (Array.isArray(options.scene) ? options.scene : options.scene === undefined ? [] : [options.scene]).map(x => x.trim());
    if (!scenes.length || scenes.some(x => !x)) throw new ExperimentError(400, 'invalid_request', 'Scene edits need a scene: one description for every slide, or one non-empty description per slide.');
    if (scenes.some(x => x.length > SCENE_MAX)) throw new ExperimentError(400, 'invalid_request', `A scene description is at most ${SCENE_MAX} characters.`);
    if (options.character !== undefined) throw new ExperimentError(400, 'invalid_request', 'A scene edit keeps the person: omit character, or use create mode.');
    if (hook !== undefined || overlayTexts.some(t => t !== null)) throw new ExperimentError(400, 'invalid_request', 'Scene-only edits keep source copy. Omit hook and overlayTexts, or use create mode.');
    return Instructions.parse({
      goal: EDIT_SCENE_GOAL, brand: '', audience: '', language: language.trim() || 'English',
      direction: editSceneDirection(scenes), lockedConstraints: [], variables, mode: 'controlled', sceneOverrides: scenes,
      ...(options.overlayMode ? { overlayMode: options.overlayMode } : {}),
    });
  }
  if (options.scene !== undefined) throw new ExperimentError(400, 'invalid_request', 'A scene requires variables=["scene"].');
  if (variables[0] === 'character') {
    if (!options.character?.trim()) throw new ExperimentError(400, 'invalid_request', 'Character edits need a non-empty character casting direction.');
    if (hook !== undefined || overlayTexts.some(t => t !== null)) throw new ExperimentError(400, 'invalid_request', 'Character-only edits keep source copy. Omit hook and overlayTexts, or use create mode.');
    return Instructions.parse({
      goal: EDIT_CHARACTER_GOAL, brand: '', audience: '', language: language.trim() || 'English',
      direction: editCharacterDirection(options.character), lockedConstraints: [], variables, mode: 'controlled',
      ...(options.overlayMode ? { overlayMode: options.overlayMode } : {}),
    });
  }
  if (options.character !== undefined) throw new ExperimentError(400, 'invalid_request', 'A character casting direction requires variables=["character"].');
  // SLA-431: the requested copy travels as structured values, not only as quoted
  // prose in `direction`. Property presence is the whole signal — an explicit ""
  // is a blank that must reach the renderer, and an omitted index is NOT a blank,
  // it is "keep the resolved source copy". A truthiness test here collapses those
  // two cases and silently re-injects stripped source words.
  const copyOverrides: Record<string, string> = {};
  if (hook !== undefined) copyOverrides['0'] = hook.trim();
  overlayTexts.forEach((value, index) => { if (value !== null) copyOverrides[String(index + 1)] = value.trim(); });
  return {
    goal: EDIT_GOAL, brand: '', audience: '', language: language.trim() || 'English',
    direction: editSlideDirection(hook, overlayTexts),
    lockedConstraints: [], variables: ['hook'], mode: 'controlled',
    copyOverrides,
    ...(options.overlayMode ? { overlayMode: options.overlayMode } : {}),
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
  experiment_active: 'The experiment is planning or generating; briefs cannot be edited until it stops. Call get_experiment.',
  experiment_cancelled: 'A cancelled experiment cannot be edited. Create a new experiment.',
  not_editable: 'A draft experiment has no variant briefs yet. Run plan_experiment first, then edit at review.',
  variant_frozen: 'That variant was already sent to generation (or rendered), so its brief is frozen. Only draft variants can be edited.',
  variant_in_flight: 'A provider job for this experiment is still running or unresolved. Retry or wait, then edit the draft variant.',
  variant_required: 'Pass the variantId to edit.',
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
  unapproved_variable: 'Variants may differ only in the experiment\'s chosen variables (instructions.variables on get_experiment). Shared fields you change are applied to the other draft variants automatically; this fires when a sibling is frozen or rendered, or when the variants would no longer differ in a chosen variable. The message names the fields.',
  locked_constraints: 'A brief must keep the experiment slide count and lockedConstraints exactly.',
  feedback_unsupported: 'This experiment predates the slide-contract pipeline, so it cannot be regenerated from feedback. Create a new experiment from the same slideshow.',
  variant_not_generated: 'Feedback applies to rendered slides. Generate the variant first (generate_experiment).',
  variant_not_found: 'No variant with that id in this experiment. get_experiment lists experiment.variants[].id.',
  revise_unsupported: 'This experiment predates the slide-contract pipeline, so its brief cannot be revised. Create a new experiment from the same slideshow.',
  not_revisable: 'Only a failed experiment can have its brief revised. get_experiment shows the status; retry_experiment handles paused ones.',
  no_qa_failure: 'No variant failed QA, so there is nothing to revise the brief with. Use retry_experiment for the failed jobs.',
  revise_limit: 'The brief was already revised the maximum number of times and still failed QA. Create a new experiment with a changed direction.',
  invalid_slide: 'Slide indexes are 0-based and must exist on the variant (slide 1 = index 0).',
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
 * at least 30. Priced from the server's CREDIT_COSTS / slideFanout(). It is a
 * runaway guard only: an approved estimate may raise it (applyApprovedEstimate).
 */
export function defaultExperimentCap(variantCount: number, slideCount: number, withSource = true): number {
  const total = (withSource ? CREDIT_COSTS.analyzeVideo : 0) + 2 * CREDIT_COSTS.experimentPlanningCall
    + variantCount * slideCount * CREDIT_COSTS.experimentSlide * slideFanout();
  return Math.min(MAX_EXPERIMENT_CREDITS, Math.max(30, Math.ceil((total * 2) / 10) * 10));
}

const STATUS_HINTS: Record<string, string> = {
  draft: 'Draft — nothing spent yet (a brief-only draft has no source video: planning writes the variants straight from the brief). Next: estimate_experiment(stage="plan"), get the user\'s OK on totalCredits, then plan_experiment.',
  planning: 'Planning in the background: analyzing sources, writing the pattern report, then variant briefs. Check back with get_experiment in a minute or two — do not poll rapidly.',
  review: 'Variant briefs are ready. Review them (optionally edit with update_experiment_variant), then estimate_experiment(stage="generate", variantIds) and generate_experiment for the chosen variants.',
  generating: 'Rendering slide images in the background. Check back with get_experiment in a few minutes — do not poll rapidly.',
  completed: 'All selected variants are rendered. Image URLs are in progress.variants[].imageUrls.',
  failed: 'A step failed. See error / progress.retryableJobs, then estimate and retry_experiment. Jobs marked terminalQa are verdicts on the slide contract: do not retry them, call revise_experiment instead (estimate_experiment stage="revise" first): the model rewrites the brief from the QA failures and re-renders.',
  paused: 'Paused (budget guard or provider outcome unknown). See error; retry_experiment resumes named jobs.',
  cancelled: 'Cancelled — terminal. delete_experiment removes it and its images.',
};

type JobCounts = Record<string, number>;
/** A pending task that already failed an attempt and is waiting out its backoff is retrying, not stuck. */
const isRetrying = (t: Experiment['tasks'][number]) => t.status === 'pending' && Boolean(t.error || t.nextAttemptAt);
function countJobs(e: Experiment): Record<string, JobCounts> {
  const out: Record<string, JobCounts> = {};
  for (const t of e.tasks) {
    const row = (out[t.kind] ??= {});
    const key = isRetrying(t) ? 'retrying' : t.status;
    row[key] = (row[key] ?? 0) + 1;
  }
  return out;
}

/** A terminal QA verdict (SLA-528) is a finding about the slide's compiled
 *  contract, not about one render: a retry re-asks the identical questions and
 *  pays for the render fan-out and QA calls again. A checker that failed to
 *  answer (`story_check_error`) is infrastructure and stays an ordinary retry. */
// A slide's story check, or an arm's deck verdict after its repair round (`qa_failed:`, SLA-820): both need a brief change, not a retry.
const TERMINAL_QA_ERROR = /(?:^|:)story_(?:check_failed|unverified):(?!story_check_error)|^qa_failed:/;
export const isTerminalQaError = (error: string | undefined | null): boolean => TERMINAL_QA_ERROR.test(error ?? '');
/** A content-filter refusal (SLA-787/816) is deterministic for the request that was refused. It is refunded and never auto-retried. */
export const isContentFilterError = (error: string | undefined | null): boolean => /(?:^|:)provider_content_filtered/.test(error ?? '');
const CONTENT_FILTER_ADVICE = 'The image provider refused this slide on a content filter; the diagnostic carries its status and message. Resending the same request is unlikely to help and pays again. Change the brief or the reference first; overlayMode "script" only helps when the refusal came from the overlay copy.';
const TERMINAL_QA_ADVICE = 'Terminal QA verdict on this slide\'s contract. Not retryable as-is: a retry re-asks the same checks and pays again. Read the failing checks in the error, change the brief or fix the contract first.';

/** "brief" = created from a brief with no source video; "videos" = created from Gallery slideshows. */
const sourceMode = (e: Pick<Experiment, 'inputs'>): 'brief' | 'videos' => e.inputs.length ? 'videos' : 'brief';

/** Agent-sized view of where an experiment is. Reads only. */
export function experimentProgress(e: Experiment) {
  return {
    status: e.status,
    hint: STATUS_HINTS[e.status] ?? null,
    error: e.error,
    credits: { charged: e.creditsCharged, max: e.maxCredits },
    sourceMode: sourceMode(e),
    sources: { total: e.inputs.length, ready: e.inputs.filter(i => i.status === 'ready').length },
    reportReady: Boolean(e.report) || (e.pipeline === 'contract' && Boolean(e.contract)),
    jobs: countJobs(e),
    retryingJobs: e.tasks.filter(isRetrying).map(({ id, kind, target, index, attempts, error, nextAttemptAt }) => ({
      id, kind, target, index, attempts, error: error ?? null,
      nextAttemptAt: nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null,
    })),
    retryableJobs: e.tasks
      .filter(t => (t.status === 'failed' || t.status === 'unknown') && t.attempts < MAX_MANUAL_ATTEMPTS)
      .map(({ id, kind, target, index, status, error, attempts, diagnostic }) => {
        const terminalQa = isTerminalQaError(error);
        const contentFiltered = isContentFilterError(error);
        return {
          id, kind, target, index, status, error, attempts, terminalQa, contentFiltered,
          ...(diagnostic ? { diagnostic } : {}),
          ...(terminalQa ? { advice: TERMINAL_QA_ADVICE } : contentFiltered ? { advice: CONTENT_FILTER_ADVICE } : {}),
        };
      }),
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
    sourceMode: sourceMode(e),
    videoIds: e.inputs.map(i => i.videoId),
    variantCount: e.variantCount,
    slideCount: e.slideCount,
    variants: e.variants.length,
    maxCredits: e.maxCredits,
    creditsCharged: e.creditsCharged,
    ranBy: e.ranBy ?? null,
    testKey: e.testKey ?? null,
    testMaxCredits: e.testMaxCredits ?? null,
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
      const all = experimentProgress(e).retryableJobs;
      const jobs = all.filter(j => !j.terminalQa && !j.contentFiltered).map(j => j.id);
      const revisable = e.status === 'failed' && e.pipeline === 'contract' && e.variants.some(v => v.qaDeck?.verdict === 'failed');
      if (revisable && !jobs.length) {
        return [{ label: 'Price a revision: the model rewrites the brief from the QA failures, then every arm is re-rendered', tool: 'estimate_experiment', args: { experimentId: id, stage: 'revise' }, why: 'Free. ' + TERMINAL_QA_ADVICE }];
      }
      if (all.length && !jobs.length) {
        const filteredOnly = all.every(j => j.contentFiltered);
        return [{ label: filteredOnly ? 'Do not resend: every failed slide was refused by the provider content filter' : 'Do not retry: every failed slide is a terminal verdict', tool: 'get_experiment', args: { experimentId: id }, why: filteredOnly ? CONTENT_FILTER_ADVICE : TERMINAL_QA_ADVICE }];
      }
      return [{ label: 'Price a retry of the failed jobs', tool: 'estimate_experiment', args: jobs.length ? { experimentId: id, stage: 'generate', taskIds: jobs } : { experimentId: id, stage: (e.report || e.pipeline === 'contract') && e.variants.length ? 'generate' : 'plan' }, why: all.length > jobs.length ? 'Free. Retries re-charge the retried jobs. Slides marked terminalQa or contentFiltered are left out: they cannot pass without a contract, brief or reference change.' : 'Free. Retries re-charge the retried jobs.' }];
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
  d: ExperimentToolDeps, e: Experiment, stage: 'plan' | 'generate' | 'revise', approvedCredits: number, variantIds?: string[], taskIds?: string[],
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
const ranByField = z.string().max(400).optional().describe(
  'Who is running this: "user" when the user asked directly, or "agent:<name>" when an AI agent acts for them, '
  + 'e.g. "agent:Leo". Pass only the agent name; an "on behalf of <user>" suffix is dropped. Free text, trimmed and capped at 120 characters. Always pass it so the owner can see who ran what.',
);
// Responses expose the value as `ranBy`, so agents echo that spelling back; without
// this alias zod strips the unknown key and the experiment is stored with ranBy null.
const ranByAliasField = z.string().max(400).optional().describe('Alias of ran_by (the name responses use). If both are given, ran_by wins.');
const testKeyField = z.string().max(80).optional().describe(
  'Stable slug for the TEST this experiment belongs to, i.e. the hypothesis, not the run (e.g. "tier-ladder-mewing"). Lower-case a-z, 0-9, ".", "_", ":", "-". '
  + 'Pass the same key on every attempt: a re-created run after a failure is another attempt of the same test. list_experiments(test_key) then returns '
  + 'all attempts and their total spend, so check it before creating and continue an open attempt instead of starting a duplicate.',
);
const testMaxCreditsField = z.number().int().min(1).max(100_000).optional().describe(
  'Credit cap for the whole test: every experiment with this test_key together, not just this one. Needs test_key. Planning, generation, retries and '
  + 'feedback rounds that would push the test past it are refused (test_budget_exceeded). Pass the budget the user approved for the test, on every attempt.',
);
const tagGoalField = z.boolean().default(false).describe(
  'Append "— @handle · source caption snippet (views)" to the stored goal so the title names the source. Default false: '
  + 'the source caption can name a competitor or creator and must not leak into the goal. Source videos are listed on every experiment anyway.',
);
const notifyField = z.object({
  url: z.string().max(2048).optional().describe('https URL (port 443, public host) that receives a signed POST when the experiment reaches completed, review, failed, paused or cancelled.'),
  secret: z.string().min(16).max(256).optional().describe('Signing secret for the Standard Webhooks HMAC-SHA256 headers (webhook-id, webhook-timestamp, webhook-signature). Omit it and one is generated and returned once as notify.signingSecret.'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Opaque JSON (up to 4 KB) echoed back unchanged in every delivery. Paperclip agents: set { paperclipIssueId: <the current task UUID>, agentId: <your own agent UUID> } instead of a url to be woken by a child task of that task, assigned to you.'),
}).optional().describe(
  'Optional completion webhook. Instead of polling get_experiment, get one POST per terminal transition (idempotency key experimentId:status:version, retried with backoff for ~24h). '
  + 'Needs a url, or metadata.paperclipIssueId for Paperclip delivery. Applies to every experiment this call creates.',
);
const approvedCreditsField = z.number().int().min(0).describe(
  'The credit amount the user has approved for this step: either the totalCredits from estimate_experiment that they confirmed, '
  + 'or, under a standing budget (a per-experiment or per-batch credit cap granted in the task), the remaining cap. '
  + 'The step runs only when the fresh estimate is <= this number; if it is higher, nothing is started and the new estimate is returned.',
);
const VARIABLE_INPUT = z.enum([...VARIABLE_FIELDS, 'angle']);
const instructionsInput = z.object({
  goal: z.string().min(1).max(2000).describe('What the experiment should find out, e.g. "Find an opening hook that earns the first swipe".'),
  brand: z.string().max(2000).default(''),
  audience: z.string().max(2000).default(''),
  language: z.string().min(1).max(80).default('English'),
  direction: z.string().max(DIRECTION_MAX).optional().describe(`Creative direction (up to ${DIRECTION_MAX} characters); add desired variable values here, e.g. "Desired variable values: a question versus a statement". Omit it to use the sourceFormat preset's direction. Required in mode "brief": with no source video it is the whole spec, so write the per-slide scene and exact overlay copy here.`),
  lockedConstraints: z.array(z.string().min(1).max(2000)).max(20).optional().describe('Rules every variant must keep, one per entry. Added to the always-on and sourceFormat locks, never replacing them.'),
  sourceFormat: z.enum(SOURCE_FORMATS).optional().describe(
    'What kind of source this is: statue-collage, sprite-vs-real, annotated-face, ai-render, sketch, portrait-collage or photo-person. '
    + 'Expands to default variables, mode, direction and locks, and emits person-appearance locks (hair, eyes, wardrobe...) only where the source shows a photographic person. '
    + 'Always locks: no source watermarks/handles/competitor brands, our app on the CTA slide, no real or celebrity likeness, adults only. '
    + 'Inferred from the source analysis when omitted; your own variables/mode/direction win over the preset.',
  ),
  variables: z.array(VARIABLE_INPUT).min(1).max(7).optional().describe(
    'What to vary: hook, character, visualStyle, caption, cta (controlled mode), plus concept/"angle" and slides (exploration mode only). Required unless sourceFormat is given or can be inferred.',
  ),
  mode: z.enum(['controlled', 'exploration']).optional().describe(
    'controlled (default without a preset): each alternate changes one of the selected variables vs the baseline. exploration (SaaS Explore combinations): an alternate may change several selected variables together, including hook + character + visualStyle; concept/slides are allowed.',
  ),
  varySupportingOverlays: z.boolean().optional().describe('Hook tests only (controlled, variables=["hook"]): variants may also retell slide 2+ overlay text while scenes stay identical.'),
  overlayMode: z.enum(['model', 'script']).optional().describe('Who draws the overlay text. "model" (default): the image model renders it. "script": slides are rendered text-free and the text is composed in code afterwards — use it when the image provider rejects slides with a content-filter error caused by the copy. It cannot help when the scene or reference image is what the provider refuses.'),
  preserveSourceCtaSlide: z.boolean().optional().describe('Keep the source deck\'s own closing call-to-action slide in the deck instead of subtracting it from the slide count (default false, which drops a detected final CTA slide).'),
});
const briefSlideInput = z.object({ role: z.string().min(1).max(80), scene: z.string().min(1).max(2000), overlayText: z.string().max(2000).default(''),
  composition: z.string().max(2000).optional().describe('Slide contract field. Omit to keep the stored value.'),
  visibleChange: z.string().max(2000).optional().describe('Slide contract field: what visibly changes on this slide. Omit to keep the stored value.'),
  arcLevel: z.enum(ARC_LEVELS).optional().describe('Slide contract field: this slide\'s arc level. Omit to keep the stored value.') });
const briefInput = z.object({
  concept: z.string().min(1).max(2000), hook: z.string().min(1).max(2000), character: z.string().max(2000),
  visualStyle: z.string().min(1).max(2000), caption: z.string().max(2000), cta: z.string().max(2000),
  lockedConstraints: z.array(z.string().min(1).max(2000)).max(20),
  slides: z.array(briefSlideInput).min(3).max(8),
  // SLA-431: must be accepted here or zod strips it silently and an explicitly
  // blank slide 1 loses both of its carriers on the documented review step.
  copyOverrides: CopyOverrides.optional(),
});

// ---- tools -----------------------------------------------------------------

const LIFECYCLE =
  'Experiment lifecycle: create_experiment (draft, free) → estimate_experiment stage=plan → user approves → plan_experiment '
  + '(background: source analysis, pattern report, variant briefs) → status "review" → optionally update_experiment_variant → '
  + 'estimate_experiment stage=generate → user approves → generate_experiment (background slide rendering) → "completed". '
  + 'Approval: a spending step needs the user\'s OK, and a standing budget IS that OK. If the task or user granted a credit cap '
  + '(per experiment or per batch), any estimate within the remaining cap is already approved: pass the remaining cap (or the estimate) as '
  + 'approvedCredits and run plan → generate without asking again. Without a cap, ask ONCE for all experiments and both stages together, '
  + 'not per experiment or per stage. Ask again only when an estimate exceeds what was approved. '
  + 'To change a brief, use update_experiment_variant (free) rather than cancel_experiment.';

export function registerExperimentTools(server: McpServer, d: ExperimentToolDeps = defaultExperimentToolDeps) {
  // ---- list_experiments ----
  server.tool('list_experiments',
    'List slideshow experiments in this workspace, newest first (paginated). Free. Each row shows status, goal, source '
    + 'videos, credits charged and ranBy; filter to one runner with ran_by. Use it to find experiments parked in "review" '
    + '(briefs ready, generation not started) or "paused"/"failed" (retry_experiment) and move them forward instead of '
    + `creating duplicates. Use get_experiment for briefs, jobs and images. ${LIFECYCLE}`,
    {
      workspaceId: workspaceIdField,
      limit: z.number().int().min(1).max(50).default(12),
      offset: z.number().int().min(0).default(0).describe('Pass nextOffset from the previous page.'),
      ran_by: z.string().max(400).optional().describe('Only experiments whose ranBy equals this value exactly (e.g. "agent:Leo"). Omit for all.'),
      ranBy: ranByAliasField,
      test_key: z.string().max(80).optional().describe('Only the attempts of this test (the test_key given at create). Adds a `test` block: every attempt oldest first, total credits charged, the test cap and what is left of it.'),
      testKey: z.string().max(80).optional().describe('Alias of test_key (the name responses use).'),
    },
    { readOnlyHint: true },
    ({ workspaceId, limit, offset, ran_by, ranBy, test_key, testKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const key = normalizeTestKey(test_key ?? testKey);
      // One extra row reveals whether another page exists (same as api/experiments.ts).
      const rows = await d.list(workspace.id, limit + 1, offset, { ranBy: ran_by ?? ranBy, testKey: key });
      const nextOffset = rows.length > limit ? offset + limit : null;
      const test = key && d.testSummary ? await d.testSummary(workspace.id, key) : undefined;
      return text({ experiments: rows.slice(0, limit).map(listRow), nextOffset, ...(key ? { test: test ?? null } : {}) });
    }));

  // ---- get_experiment ----
  server.tool('get_experiment',
    'Get one experiment: the full record (instructions, pattern report, variant briefs, slides, jobs) plus a compact '
    + '`progress` block — status with what to do next, job counts per stage, retryable jobs, and per-variant '
    + 'revision / slides done / image URLs. Free. Planning and generation run in the background; call this again '
    + 'after a minute or two rather than polling rapidly. Jobs that failed an attempt and wait out a backoff show as '
    + '`retrying` (progress.retryingJobs: error + nextAttemptAt). The job ids in `experiment.jobs[].id` are NOT for '
    + 'await_job / get_job_status — this tool is how experiment jobs are tracked.',
    { workspaceId: workspaceIdField, experimentId: experimentIdField },
    { readOnlyHint: true },
    ({ workspaceId, experimentId }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      return text(withNextSteps({ experiment: d.serialize(e), progress: experimentProgress(e) }, lifecycleSteps(e)));
    }));

  // ---- create_experiment ----
  server.tool('create_experiment',
    'Create draft experiment(s). Free — a draft spends nothing. Three modes, matching the site\'s '
    + 'experiment wizard (source choices: Gallery slideshows, one slideshow to edit, or no source at all):\n'
    + '• mode "brief" — NO source video. One experiment generated from a written brief. Do not pass videoIds. Give `instructions` '
    + 'with goal, variables, language, brand, audience, lockedConstraints and a `direction` that is the whole spec (per-slide scene and exact overlay copy, up to '
    + `${DIRECTION_MAX} characters; required), plus slideCount (3–8, the real output length, not clamped to any source), variantCount and maxCredits. `
    + 'It still creates a free draft with a planEstimate and follows plan_experiment → review → generate_experiment with the same approval gates; planning skips source analysis.\n'
    + '• mode "create" (default) — one experiment PER source video, because briefs never mix sources, so N videoIds '
    + 'create N drafts. Give `instructions`: what to vary, the goal, optional creative direction. Pass '
    + '`instructions.preserveSourceCtaSlide: true` to keep a source deck\'s own closing call-to-action slide in the deck.\n'
    + '• mode "edit" — exactly ONE deck. For a character-only edit pass variables:["character"] and `character` '
    + '(visible casting direction); omit hook/overlayTexts to keep all source copy, style, setting and story locked. '
    + 'For a scene edit pass variables:["scene"] and `scene` (one description for every slide, or one per slide): each slide is an edit of the baseline slide that '
    + 'keeps the same person, medium, lighting, camera and overlay text and changes only the setting, props and action; omit hook/overlayTexts. '
    + 'For a copy edit (variables:["hook"], default), keep the same images and pass `hook` '
    + '(slide 1) and `overlayTexts` (slides 2, 3, … in order; an empty string strips that slide\'s text, null leaves it unchanged) instead of '
    + '`instructions`; the tool assembles the same brief the site sends — fixed goal, one selected variable, '
    + 'controlled mode, 2 variants, a 100-credit cap — with the copy quoted per slide in the site\'s wording. '
    + 'The source deck\'s own slide count wins when it is known; pass slideCount only if you do not have it.\n'
    + 'Sources must be slideshows or videos with a finished Recreate deck (show_gallery marks them). '
    + `Credits: analysis ${CREDIT_COSTS.analyzeVideo}/source + ${CREDIT_COSTS.experimentPlanningCall} per planning call at plan time; `
    + `${CREDIT_COSTS.experimentSlide} per slide render at generation: one render per slide, and slides the alternative shares with the baseline are free. `
    + `A QA check of each deck (${CREDIT_COSTS.experimentPlanningCall}) is added, and estimate_experiment(stage="generate") gives the exact total. ${LIFECYCLE}`,
    {
      workspaceId: workspaceIdField,
      mode: z.enum(['edit', 'create', 'brief']).default('create').describe(
        '"create" (default) = new variations from source videos plus instructions. "edit" = change overlay copy or character on one deck. "brief" = no source video: generate from instructions alone.',
      ),
      videoIds: z.array(Id).min(1).max(20).optional().describe('Required in create and edit modes: 1–20 distinct Gallery video ids; one experiment per video. Edit mode takes exactly one. Must be omitted in brief mode.'),
      instructions: instructionsInput.optional().describe('CREATE and BRIEF modes. Required in both; rejected in edit mode (use top-level variables and character or hook/overlayTexts). Brief mode also requires instructions.direction.'),
      variables: z.array(z.enum(['hook', 'character', 'scene'])).length(1).optional().describe(
        'EDIT mode: ["hook"] for copy, ["character"] for casting only, or ["scene"] for the setting. Defaults to scene when scene is supplied, then character when character is supplied, otherwise hook.',
      ),
      scene: z.union([z.string().trim().min(1).max(SCENE_MAX), z.array(z.string().trim().min(1).max(SCENE_MAX)).min(1).max(8)]).optional().describe(
        'EDIT mode, scene variable: where the deck takes place instead (setting, props, action). One description for every slide, or an array with one per slide. Keeps the same person, medium, lighting, camera and overlay text. Omit hook/overlayTexts/character.',
      ),
      character: z.string().trim().min(1).max(EDIT_CHARACTER_MAX).optional().describe(
        'EDIT mode, character variable: visible casting changes (e.g. short blond hair). Keeps source copy, style, setting and story. Omit hook/overlayTexts.',
      ),
      // The 200-character caps match the site's own input maxlength, and they
      // are what keeps the quoted direction under Instructions.direction's
      // 2000-char limit: 8 values x 200 + the per-slide framing is ~1968. At the
      // old max(2000) an edit of 4 x 600-char slides was refused outright.
      hook: z.string().max(EDIT_COPY_MAX).optional().describe(
        'EDIT mode: the exact words for slide 1. OMIT this field to leave slide 1 unchanged; send an empty string only to strip slide 1\'s text.',
      ),
      overlayTexts: z.array(z.string().max(EDIT_COPY_MAX).nullable()).max(7).optional().describe(
        'EDIT mode: overlay text for slides 2, 3, … in order. Empty string = render no text on that slide. null = leave that slide\'s original text unchanged (use it to skip a slide between two you are editing).',
      ),
      language: z.string().trim().min(1).max(80).optional().describe('EDIT mode: output language for the copy (default English).'),
      overlayMode: z.enum(['model', 'script']).optional().describe('EDIT mode: "script" renders slides text-free and composes the copy in code (use when the image provider rejects slides with a content-filter error). Default "model". In create mode use instructions.overlayMode.'),
      variantCount: z.number().int().min(1).max(12).default(3).describe('CREATE mode: variants per experiment, including the baseline (1–12). Edit mode is always 2.'),
      slideCount: z.number().int().min(3).max(8).default(5).describe('Slides per variant (3–8); overridden by the source deck length when known, minus a detected source CTA slide unless instructions.preserveSourceCtaSlide is true. Brief mode has no source deck, so this is exactly the output length.'),
      maxCredits: z.number().int().min(1).max(MAX_EXPERIMENT_CREDITS).optional().describe(
        'Per-experiment credit ceiling (runaway guard). Default: the site\'s automatic cap, 2× the estimate rounded up; 100 in edit mode. An approved estimate may raise it.',
      ),
      idempotencyKey: idempotencyKeyField,
      ran_by: ranByField,
      ranBy: ranByAliasField,
      tagGoalWithSource: tagGoalField,
      notify: notifyField,
      test_key: testKeyField,
      test_max_credits: testMaxCreditsField,
    },
    { readOnlyHint: false },
    ({ workspaceId, mode, videoIds, instructions, variables, character, scene, hook, overlayTexts, language, overlayMode, variantCount, slideCount, maxCredits, idempotencyKey, ran_by: ranByRaw, ranBy: ranByCamel, tagGoalWithSource, notify, test_key, test_max_credits }) => guarded(async () => {
      const ran_by = ranByRaw ?? ranByCamel;
      const test = { ...(test_key === undefined ? {} : { test_key }), ...(test_max_credits === undefined ? {} : { test_max_credits }) };
      const workspace = await d.resolveWorkspace({ workspaceId });
      if (mode === 'brief') {
        if (videoIds?.length) return text({ error: 'invalid_request', message: 'mode "brief" has no source video — omit videoIds, or use mode "create" to generate from slideshows.' }, true);
        if (variables || character !== undefined || scene !== undefined || hook !== undefined || overlayTexts !== undefined || language !== undefined || overlayMode !== undefined) {
          return text({ error: 'invalid_request', message: 'mode "brief" takes everything in instructions (variables, language, direction, instructions.overlayMode); top-level variables/character/hook/overlayTexts/language/overlayMode are edit-only.' }, true);
        }
        if (!instructions) return text({ error: 'invalid_request', message: 'mode "brief" needs instructions — at least a goal and a direction that spells out the slides.' }, true);
        if (!instructions.direction?.trim()) return text({ error: 'invalid_request', message: 'mode "brief" has no source video, so instructions.direction is the spec: write the per-slide scene and exact overlay copy there.' }, true);
        const cap = maxCredits ?? defaultExperimentCap(variantCount, slideCount, false);
        const body = { workspaceId: workspace.id, instructions, variantCount, slideCount, maxCredits: cap };
        const key = idempotencyKey ?? derivedKey('create', body);
        try {
          const e = await d.createExperiment({ ...body, idempotencyKey: key, ...(ran_by === undefined ? {} : { ran_by }), ...(notify === undefined ? {} : { notify }), ...test }, undefined, { sourceless: true });
          const planEstimate = await d.estimate(e, 'plan');
          const row = { ...listRow(e), ...(e.notify ? { notify: e.notify } : {}), idempotencyKey: key, planEstimate };
          return text(withNextSteps({
            message: 'Created 1 draft experiment from a brief (no source video). Nothing was charged.',
            experiments: [row],
            failed: [],
            note: 'Repeating this exact call returns the same draft. To deliberately create a duplicate, pass a new idempotencyKey.',
          }, [{
            label: `Plan experiment ${e.id.slice(0, 8)}`,
            tool: 'plan_experiment',
            args: { experimentId: e.id, approvedCredits: planEstimate.totalCredits },
            cost: credits(planEstimate.totalCredits),
            spendsMoney: true,
            why: 'Writes the variant briefs straight from the brief (no source analysis) for review.',
          }]));
        } catch (err) {
          return experimentToolError(err);
        }
      }
      if (!videoIds?.length) return text({ error: 'invalid_request', message: `mode "${mode}" needs videoIds (1–20 Gallery videos). For no source video, use mode "brief".` }, true);
      if (new Set(videoIds).size !== videoIds.length) return text({ error: 'invalid_request', message: 'videoIds must be distinct.' }, true);
      if (mode === 'edit') {
        if (instructions) return text({ error: 'invalid_request', message: 'Edit mode uses top-level variables and character or hook/overlayTexts. Use create mode to pass instructions.' }, true);
        // One deck: the site's edit path never fans out, so a second id here
        // is a caller mistake rather than two experiments to build.
        if (videoIds.length !== 1) {
          return text({ error: 'invalid_request', message: 'mode "edit" works on exactly one slideshow — pass a single videoId, or use mode "create".' }, true);
        }
        if (!character && scene === undefined && variables?.[0] !== 'character' && variables?.[0] !== 'scene' && !hook?.trim() && !(overlayTexts ?? []).some(t => t?.trim())) {
          return text({ error: 'invalid_request', message: 'mode "edit" needs new copy: a hook for slide 1, or overlay text for a later slide.' }, true);
        }
      } else if (variables || character !== undefined || scene !== undefined || overlayMode !== undefined) {
        return text({ error: 'invalid_request', message: 'Create mode uses instructions.variables and instructions.direction; top-level variables/character/overlayMode are edit-only (create mode: instructions.overlayMode).' }, true);
      } else if (!instructions) {
        return text({ error: 'invalid_request', message: 'mode "create" needs instructions — a goal and at least one variable to test.' }, true);
      }
      const edit = mode === 'edit'
        ? {
          instructions: editInstructions(hook, overlayTexts ?? [], language ?? 'English', { variables, character, scene, overlayMode }),
          variantCount: EDIT_VARIANT_COUNT,
          maxCredits: EDIT_MAX_CREDITS,
        }
        : { instructions: instructions!, variantCount, maxCredits: maxCredits ?? defaultExperimentCap(variantCount, slideCount) };
      const created: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];
      const deduped = d.dedupeSourcePosts ? await d.dedupeSourcePosts(workspace.id, videoIds) : { videoIds, duplicates: [] };
      for (const videoId of deduped.videoIds) {
        const i = videoIds.indexOf(videoId);
        const body = { workspaceId: workspace.id, videoIds: [videoId], ...edit, slideCount, maxCredits: edit.maxCredits };
        const key = idempotencyKey
          ? (videoIds.length === 1 ? idempotencyKey : `${idempotencyKey}:${i + 1}`)
          : derivedKey('create', body);
        try {
          const e = await d.createExperiment({ ...body, idempotencyKey: key, ...(ran_by === undefined ? {} : { ran_by }), ...(notify === undefined ? {} : { notify }), ...test }, undefined, { ...(mode === 'edit' ? { expandFormat: false } : {}), tagGoal: tagGoalWithSource });
          created.push({ ...listRow(e), ...(e.notify ? { notify: e.notify } : {}), idempotencyKey: key, planEstimate: await d.estimate(e, 'plan') });
        } catch (err) {
          const payload = JSON.parse(experimentToolError(err).content[0]!.text);
          failed.push({ videoId, ...payload });
        }
      }
      const payload = {
        message: `Created ${created.length} of ${deduped.videoIds.length} draft experiment${deduped.videoIds.length === 1 ? '' : 's'}. Nothing was charged.`,
        experiments: created,
        failed,
        ...(deduped.duplicates.length ? { skippedDuplicates: deduped.duplicates, duplicateNote: 'These videoIds are the same post as another id in this call (same platform and externalId), so no second experiment was created.' } : {}),
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
    + 'get_experiment progress.retryableJobs) to price retrying exactly those jobs. stage="revise" prices revise_experiment (the model rewrites '
    + 'the brief from the QA failures, then every arm is re-rendered). Returns totalCredits, the workspace '
    + 'wallet (workspaceCredits) and the experiment cap. If totalCredits is within a standing credit cap the user granted, it is '
    + 'already approved: pass the cap (or totalCredits) as approvedCredits to plan_experiment / generate_experiment / retry_experiment. '
    + 'Otherwise show totalCredits to the user and get a yes first (one request covering all experiments and both stages).',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      stage: z.enum(['plan', 'generate', 'revise']),
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
          ? 'Within a standing credit cap this is already approved; otherwise ask the user to approve totalCredits before starting this step.'
          : 'Not enough credits in the workspace wallet for this step. The user needs to add credits first.',
      });
    }));

  // ---- plan_experiment ----
  server.tool('plan_experiment',
    'Start planning a DRAFT experiment: source analysis, pattern report, then variant briefs, all in the background. '
    + 'SPENDS CREDITS — call estimate_experiment(stage="plan") first. Pass as approvedCredits the amount already approved: '
    + 'the confirmed totalCredits, or under a standing credit cap (per experiment or per batch) the remaining cap, which counts as approval '
    + 'when the estimate is within it, so no extra confirmation is needed. Ask the user only when the estimate exceeds the approval. '
    + 'Afterwards status is "planning"; check with get_experiment until it reaches "review". The job ids it returns '
    + '(experiment.jobs[].id) are NOT for await_job / get_job_status; track them with get_experiment.',
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
    'Edit one variant\'s brief. Free. Allowed only when the variant is a draft (never sent to generation, no frozen brief) '
    + 'and the experiment is: "review"; "completed" (for a draft variant that was not generated); or "failed"/"paused" while no '
    + 'provider job is running or unknown. Refused while "planning" or "generating" (experiment_active), when "cancelled" '
    + '(experiment_cancelled), and in "draft" before planning has produced briefs (not_editable). A frozen or rendered variant is '
    + 'refused (variant_frozen). Pass the variant\'s current revision (get_experiment) — a stale revision is refused '
    + '(revision_conflict), never overwritten. The brief must keep the experiment\'s slide count and lockedConstraints. Variants '
    + 'may differ only in the experiment\'s chosen variables (instructions.variables on get_experiment); every other brief field '
    + '(e.g. cta, caption, character, visualStyle, concept, slides when not chosen) is shared. Edit a shared field on any ONE draft '
    + 'variant and the same change is applied to the other draft variants automatically, so retargeting the whole experiment '
    + '(new topic, new copy) works one variant at a time; a chosen variable is edited per variant. If a shared field cannot be '
    + 'mirrored (another variant is frozen/rendered) or a variant would stop differing in a chosen variable, the edit is refused '
    + '(422 unapproved_variable) and the message names the fields. Optional title and hypothesis rename the variant (not part '
    + 'of the brief). Returns the edited variant\'s new revision; any other variant that was updated gets a new revision too, so '
    + 'use the revisions in the result when calling generate_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      variantId: Id.describe('Variant id from get_experiment.'),
      revision: z.number().int().positive().describe('The variant\'s current revision.'),
      brief: briefInput.describe('The complete edited brief (all fields, not a patch). Per-slide contract fields (composition, visibleChange, arcLevel) you omit keep their stored value, so you can reword one without resending the rest.'),
      title: z.string().min(1).max(160).optional().describe('New variant title (1–160 characters). Omit to keep the current one.'),
      hypothesis: z.string().min(1).max(2000).optional().describe('New variant hypothesis. Omit to keep the current one.'),
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, variantId, revision, brief, title, hypothesis }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const before = await d.load(workspace.id, experimentId);
      const next = await d.mutate(workspace.id, experimentId, 'edit', { workspaceId: workspace.id, revision, brief, ...(title === undefined ? {} : { title }), ...(hypothesis === undefined ? {} : { hypothesis }) }, variantId);
      const v = next.variants.find(x => x.id === variantId);
      const synced = next.variants.filter(x => x.id !== variantId && x.revision !== before.variants.find(y => y.id === x.id)?.revision);
      const note = synced.length ? ` Shared fields were also applied to: ${synced.map(x => `${x.id} (revision ${x.revision})`).join(', ')}.` : '';
      return mutationResult(d, next, `Brief saved. Variant is now at revision ${v?.revision ?? '?'}.${note}`);
    }));

  // ---- generate_experiment ----
  server.tool('generate_experiment',
    'Render slide images for reviewed variants (status "review", or "completed" with draft variants left). SPENDS CREDITS — '
    + `${CREDIT_COSTS.experimentSlide} per slide render (one render per slide; slides shared with the baseline are free), plus a QA check per deck (${CREDIT_COSTS.experimentPlanningCall}). Call estimate_experiment(stage="generate", variantIds) `
    + 'first. approvedCredits is the amount already approved: the confirmed totalCredits, or under a standing credit cap '
    + '(per experiment or per batch) the remaining cap, which counts as approval when the estimate is within it. Ask the user only when '
    + 'the estimate exceeds it. Pass each variant with its CURRENT revision (get_experiment); the brief '
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
    + 'estimate_experiment with the same scope first. approvedCredits is the amount already approved: the confirmed totalCredits, or under '
    + 'a standing credit cap the remaining cap, which counts as approval when the estimate is within it. Ask the user only when it exceeds '
    + 'the approval. Prefer retry over cancel+recreate; completed images are kept.',
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
          : await approvalGate(d, e, stage ?? ((e.report || e.pipeline === 'contract') && e.variants.length ? 'generate' : 'plan'), approvedCredits);
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

  // ---- revise_experiment ----
  server.tool('revise_experiment',
    'Retry an experiment that FAILED QA by letting the model rewrite the brief. Use it when the experiment is failed and its '
    + 'slides were judged terminal QA failures (retry_experiment cannot fix those: it would only re-judge the same images). '
    + 'The QA failures of every arm are fed back to the contract model, which writes a corrected contract and briefs (the one '
    + 'tested variable stays the only difference between the arms); then all arms are re-rendered and QA-checked. '
    + 'SPENDS CREDITS: one planning call, a full re-render and QA of every arm. Call with estimateOnly:true first (free); '
    + 'approvedCredits is the amount the user approved (or the remaining standing cap). At most a few revisions per experiment. '
    + 'Track progress with get_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      estimateOnly: z.boolean().default(false).describe('Free: return the price, start nothing.'),
      approvedCredits: approvedCreditsField.optional().describe('Required unless estimateOnly. The credits the user approved for this revision.'),
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, estimateOnly, approvedCredits, idempotencyKey }) => guarded(async () => {
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      if (estimateOnly) {
        const est = await d.estimate(e, 'revise');
        return text({ estimate: est, affordable: est.totalCredits <= est.workspaceCredits,
          note: 'Nothing was started. Within a standing credit cap this is already approved; otherwise get the user\'s OK on totalCredits, then call again with approvedCredits.' });
      }
      if (approvedCredits === undefined) return text({ error: 'invalid_request', message: 'Pass approvedCredits (or estimateOnly:true to price it first).' }, true);
      const gate = await approvalGate(d, e, 'revise', approvedCredits);
      if (gate.refusal) return gate.refusal;
      // Revisions already applied are part of the key: a lost response replays, a genuine second revision does not.
      const key = idempotencyKey ?? derivedKey('revise', { experimentId, round: e.revisions?.length ?? 0 });
      const next = await d.mutate(workspace.id, experimentId, 'revise', { workspaceId: workspace.id, idempotencyKey: key });
      return mutationResult(d, next, 'Rewriting the brief from the QA failures, then re-rendering every arm. Check back with get_experiment in a few minutes.', gate.estimate);
    }));

  // ---- submit_experiment_feedback ----
  server.tool('submit_experiment_feedback',
    'Give human feedback on a GENERATED slideshow (one variant) and regenerate it. `feedback` is about the whole slideshow and '
    + 're-renders every slide; `slides` gives feedback for single slides (0-based index: slide 1 = 0) and re-renders only those '
    + '(re-rendering the first slide of a one-person identity chain re-renders the later slides too, so the face stays the same). '
    + 'Pass either or both. Write what should change in the picture, e.g. "LTN still looks like MTN: make the jaw clearly softer '
    + 'and the face fuller". The notes stay attached to the slide, so later QA repairs of it keep them. The variant is then '
    + 'QA-checked again like a fresh render. SPENDS CREDITS: one slide render per re-rendered slide plus one QA call. '
    + 'Call it with estimateOnly:true first (free) to get the price and the slides it would redo; approvedCredits is the amount '
    + 'the user approved (or the remaining standing cap). Allowed when the experiment is completed, failed, paused or in review and '
    + 'no job of the variant is pending, running or unknown. Track progress with get_experiment.',
    {
      workspaceId: workspaceIdField,
      experimentId: experimentIdField,
      variantId: Id.describe('The generated variant (slideshow) the feedback is about: experiment.variants[].id.'),
      feedback: z.string().trim().min(1).max(FEEDBACK_MAX).optional().describe('Feedback on the whole slideshow. Regenerates every slide.'),
      slides: z.array(z.object({
        index: z.number().int().min(0).max(7).describe('0-based slide index (slide 1 = 0).'),
        feedback: z.string().trim().min(1).max(FEEDBACK_MAX).describe('What should change on this slide.'),
      })).min(1).max(8).optional().describe('Per-slide feedback. Regenerates only these slides (plus the identity chain they anchor).'),
      estimateOnly: z.boolean().default(false).describe('Free: return the price and the slides that would be re-rendered, start nothing.'),
      approvedCredits: approvedCreditsField.optional().describe('Required unless estimateOnly. The credits the user approved for this regeneration.'),
      idempotencyKey: idempotencyKeyField,
    },
    { readOnlyHint: false },
    ({ workspaceId, experimentId, variantId, feedback, slides, estimateOnly, approvedCredits, idempotencyKey }) => guarded(async () => {
      if (!d.estimateFeedback) return text({ error: 'feedback_unavailable', message: 'Feedback regeneration is not available on this server.' }, true);
      const workspace = await d.resolveWorkspace({ workspaceId });
      const e = await d.load(workspace.id, experimentId);
      const req = { variantId, ...(feedback === undefined ? {} : { feedback }), ...(slides === undefined ? {} : { slides }) };
      const estimate = await d.estimateFeedback(e, req);
      if (estimateOnly) {
        return text({ estimate, redoSlides: estimate.redo, affordable: estimate.totalCredits <= estimate.workspaceCredits,
          note: 'Nothing was started. Within a standing credit cap this is already approved; otherwise get the user\'s OK on totalCredits, then call again with approvedCredits.' });
      }
      if (approvedCredits === undefined) return text({ error: 'invalid_request', message: 'Pass approvedCredits (or estimateOnly:true to price it first).', estimate }, true);
      if (estimate.totalCredits > approvedCredits) {
        return text({ error: 'estimate_exceeds_approval', message: `The current estimate is ${estimate.totalCredits} credits, above the ${approvedCredits} the user approved. Nothing was started. Show the user this estimate and ask again.`, estimate }, true);
      }
      // A second round with the same words is a deliberate re-ask: rounds already applied are part of the key.
      const key = idempotencyKey ?? derivedKey('feedback', { experimentId, req, round: e.variants.find(v => v.id === variantId)?.feedback?.length ?? 0 });
      const next = await d.mutate(workspace.id, experimentId, 'feedback', { workspaceId: workspace.id, idempotencyKey: key, ...req });
      return mutationResult(d, next, `Regenerating ${estimate.redo.length} slide${estimate.redo.length === 1 ? '' : 's'} (${estimate.redo.map(i => i + 1).join(', ')}) with your feedback, then QA. Check back with get_experiment in a few minutes.`, estimate);
    }));

  // ---- cancel_experiment ----
  server.tool('cancel_experiment',
    'Cancel an experiment. Free; stops further background work (in-flight provider calls may still settle). Cancelled '
    + 'is terminal — it cannot be resumed. Do NOT cancel to change a brief (use update_experiment_variant) or to retry '
    + '(use retry_experiment); cancel only when the source itself is unusable. Cancel a planning/generating experiment before deleting it.',
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
