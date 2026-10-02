// ---------------------------------------------------------------------------
// MCP Tools: the experiment lifecycle — create → estimate → plan → review →
// generate, with retry / cancel / delete on the side.
//
// Same domain service the REST API uses (src/experiments/service.ts) and the
// same strict request schemas (src/experiments/schema.ts). This module adds the
// conversational surface; it does not add a second workflow. Every transition
// therefore keeps the guarantees the product depends on — the per-experiment
// credit cap, idempotency keys, variant revision checks — rather than
// reimplementing them loosely in tool land. The schemas are REUSED, not
// restated: the tool input fields below are the very field schemas of
// `Create`, `Plan`, `Generate`, `Retry`, `Estimate` and `EditBrief`, so a rule
// tightened on the backend tightens the tool with it.
//
// The spend boundary is the whole reason these are separate tools. Creating a
// draft is free. Planning and generating debit credits as the worker runs them.
// An agent that can reach generation without ever seeing a price is an agent
// that spends a user's money unasked — so estimate_experiment is free, and every
// spending tool quotes the estimate it is about to act on inside its own
// response, before the transition is reported.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { ZodError } from 'zod/v4';
import { workspaceIdField, resolveToolWorkspace } from './workspace-param.js';
import { withNextSteps, costBlock, type NextStep } from '../lib/next-steps.js';
import { InsufficientCreditsError } from '../lib/credits.js';
import { deleteObjects, thumbBucket } from '../lib/storage.js';
import * as S from '../experiments/schema.js';
import { createExperiment, estimate, mutate } from '../experiments/service.js';
import { load, list, remove, serialize } from '../experiments/store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

/** The site's edit-slideshow goal, verbatim (src/ui/gallery.ts). */
const EDIT_GOAL = 'Edit the slideshow overlay text, keeping the same images.';
/** Edit mode is one hook test with two variants and a hard 100-credit cap. */
const EDIT_VARIANT_COUNT = 2;
const EDIT_MAX_CREDITS = 100;
/** Fallback when the caller cannot see the source's slide count (site parity). */
const DEFAULT_SLIDE_COUNT = 5;

function payload(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true };
}

/**
 * Map a domain error onto a tool result instead of throwing.
 *
 * A thrown Error reaches the client as an opaque protocol failure. REST
 * answers `404 experiment_not_found` / `409 revision_conflict` / `422
 * invalid_request`, and the agent needs those exact codes to decide what to do
 * next (re-read, re-plan, or stop) — so they are reproduced here rather than
 * flattened. An unrecognised failure is logged and reported generically.
 */
function failureFor(err: unknown): ToolResult {
  if (err instanceof S.ExperimentError) {
    return failure({ error: err.code, message: err.message, statusCode: err.statusCode });
  }
  if (err instanceof ZodError) {
    return failure({
      error: 'invalid_request',
      message: 'The request did not satisfy the experiment schema.',
      statusCode: 400,
      issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof InsufficientCreditsError) {
    return failure({
      error: 'insufficient_credits',
      message: err.message,
      statusCode: 402,
      required: err.required,
      remaining: err.remaining,
    });
  }
  // requireWorkspace() throws for a workspace the caller neither owns nor is a
  // member of. That is a scoping answer, not a crash — and it must read as one
  // so a caller passing another user's workspace id stops instead of retrying.
  if (err instanceof Error && err.message === 'Workspace not found.') {
    return failure({
      error: 'workspace_not_found',
      message: 'Workspace not found. Pass a workspaceId from list_workspaces, or omit it for your primary workspace.',
      statusCode: 404,
    });
  }
  console.error('[experiments] tool failed', err instanceof Error ? err.name : 'unknown');
  return failure({
    error: 'experiment_tool_failed',
    message: err instanceof Error ? err.message : 'unknown error',
    statusCode: 500,
  });
}

async function attempt(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return failureFor(err);
  }
}

/**
 * Compact row for list_experiments: identity, spend, and enough state to
 * choose the next call without pulling every variant's briefs and slides.
 * `get_experiment` (detail: full) is the REST-shaped full record.
 */
function summarize(e: S.Experiment) {
  return {
    id: e.id,
    status: e.status,
    goal: e.instructions.goal,
    variables: e.instructions.variables,
    mode: e.instructions.mode,
    slideCount: e.slideCount,
    variantCount: e.variantCount,
    variants: e.variants.map(v => ({ id: v.id, title: v.title, status: v.status, revision: v.revision })),
    credits: { charged: e.creditsCharged, max: e.maxCredits, remaining: e.maxCredits - e.creditsCharged },
    jobs: {
      total: e.tasks.length,
      failed: e.tasks.filter(t => t.status === 'failed').length,
      unknownOutcome: e.tasks.filter(t => t.status === 'unknown').length,
    },
    error: e.error,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** "12 credits" — the one phrasing for an experiment quote. */
function creditLabel(n: number): string {
  return `${Math.ceil(n)} credit${Math.ceil(n) === 1 ? '' : 's'}`;
}

/**
 * Forward edges for a lifecycle tool response.
 *
 * The experiment spends money in two places only, and an agent that cannot see
 * the next move stops at the draft. Drafts therefore always point at the free
 * estimate AND the spending transition, with the price attached — see
 * NEXT_STEPS_GUIDANCE for the standing rule that spending steps need an
 * explicit yes.
 */
function lifecycleSteps(e: S.Experiment, quote?: { totalCredits: number }): NextStep[] {
  const read: NextStep = { label: 'Read the experiment', tool: 'get_experiment', args: { experimentId: e.id }, why: 'Free. Variants, briefs, per-job status and spend.' };
  const price = (stage: 'plan' | 'generate'): NextStep => ({
    label: `Price ${stage === 'plan' ? 'planning' : 'generation'}`,
    tool: 'estimate_experiment',
    args: { experimentId: e.id, stage },
    why: 'Free. Quotes the credits before anything is spent.',
  });
  if (e.status === 'draft') {
    return [
      price('plan'),
      {
        label: 'Start planning',
        tool: 'plan_experiment',
        args: { experimentId: e.id },
        ...(quote ? { cost: creditLabel(quote.totalCredits), spendsMoney: true } : { spendsMoney: true }),
        why: 'SPENDS CREDITS. Analyses the sources, writes the report and proposes variants — the review step follows.',
      },
    ];
  }
  if (e.status === 'review') {
    return [
      read,
      price('generate'),
      {
        label: 'Generate the variants',
        tool: 'generate_experiment',
        args: { experimentId: e.id, variants: e.variants.map(v => ({ id: v.id, revision: v.revision })) },
        ...(quote ? { cost: creditLabel(quote.totalCredits), spendsMoney: true } : { spendsMoney: true }),
        why: 'SPENDS CREDITS — the largest charge in the lifecycle. Renders every selected variant at the revision you read.',
      },
    ];
  }
  if (e.status === 'failed' || e.status === 'paused') {
    // Named jobs, not a blanket retry: the caller can price exactly what is
    // about to be re-submitted instead of everything that ever failed.
    const retryable = e.tasks.filter(t => t.status === 'failed' || t.status === 'unknown').map(t => t.id);
    return [
      read,
      {
        label: 'Retry the failed work',
        tool: 'retry_experiment',
        args: { experimentId: e.id, ...(retryable.length ? { taskIds: retryable } : {}) },
        ...(quote ? { cost: creditLabel(quote.totalCredits), spendsMoney: true } : { spendsMoney: true }),
        why: 'SPENDS CREDITS for every job it re-submits. Price it with estimate_experiment(taskIds) first.',
      },
      { label: 'Cancel the experiment', tool: 'cancel_experiment', args: { experimentId: e.id }, why: 'Free. Stops further work; nothing in flight is refunded.' },
    ];
  }
  if (e.status === 'cancelled' || e.status === 'completed') {
    return [
      read,
      { label: 'Delete the experiment', tool: 'delete_experiment', args: { experimentId: e.id }, why: 'Free in credits, but permanent: it removes the record AND its retained slide images.' },
    ];
  }
  return [read];
}

/** Retained slide/task paths owned by an experiment — the R2 cleanup set. */
function retainedPaths(e: S.Experiment): string[] {
  return [...e.tasks.map(t => t.path), ...e.variants.flatMap(v => v.slides.map(s => s.path))]
    .filter((p): p is string => !!p);
}

export function registerExperimentTools(server: McpServer) {

  // ── read ────────────────────────────────────────────────────────────────

  server.tool('list_experiments',
    'List this workspace\'s slideshow experiments, newest first. Free; no credits charged. '
    + 'Rows carry status, the variables being tested, variant ids/revisions and credit spend — enough to pick the next call. '
    + 'Use detail:"full" for the complete record (briefs, slides, per-job status), or get_experiment for one experiment. '
    + 'Experiments are paid in two places only: plan_experiment and generate_experiment. Everything else is free.',
    {
      workspaceId: workspaceIdField,
      limit: z.number().int().min(1).max(50).default(20).describe('Rows to return, 1-50 (default 20).'),
      offset: z.number().int().min(0).default(0).describe('Rows to skip (default 0).'),
      detail: z.enum(['summary', 'full']).default('summary')
        .describe('"summary" (default) = one compact row per experiment. "full" = the complete REST-shaped record per row (large).'),
    },
    async ({ workspaceId, limit, offset, detail }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      // One extra row reveals whether another page exists without a count query,
      // exactly like the REST list route.
      const rows = await list(workspace.id, limit + 1, offset);
      const page = rows.slice(0, limit);
      const nextOffset = rows.length > limit ? offset + limit : null;
      return payload({
        // Two shapes on purpose: `serialize` is the REST record, `summarize` is
        // the compact row. Mapped separately rather than through one union —
        // the detail flag is a caller-facing choice about payload size.
        experiments: detail === 'full' ? page.map(serialize) : page.map(summarize),
        nextOffset,
        ...(nextOffset === null ? {} : { nextOffsetHint: `Call again with offset=${nextOffset} for the next page.` }),
        ...(page.length ? {} : { hint: 'No experiments yet. create_experiment starts one from your slideshow videos — a draft costs nothing.' }),
      });
    }));

  server.tool('get_experiment',
    'Get one experiment: instructions, status, variants with their briefs and slides, per-job status and credit spend. '
    + 'Free; no credits charged. Read the `revision` on each variant from here and pass it back verbatim to '
    + 'generate_experiment or edit_experiment_variant — a stale revision is refused with revision_conflict, so re-read '
    + 'instead of guessing.',
    { workspaceId: workspaceIdField, experimentId: S.Id.describe('Experiment id from list_experiments or create_experiment.') },
    async ({ workspaceId, experimentId }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      // load() scopes by workspaceId, so another workspace's id reads as
      // 404 experiment_not_found — the same answer REST gives.
      const e = await load(workspace.id, experimentId);
      return payload(withNextSteps({ experiment: serialize(e), summary: summarize(e) }, lifecycleSteps(e)));
    }));

  // ── create (draft only — spends nothing) ────────────────────────────────

  server.tool('create_experiment',
    'Create a DRAFT experiment from slideshow videos. SPENDS NOTHING: the draft is stored locally and no credits move. '
    + 'Credits are only spent later, by plan_experiment and generate_experiment, and both are explicit calls you must price first '
    + 'with the free estimate_experiment. This tool returns that plan-stage estimate with the draft.\n\n'
    + 'Two modes, matching the site\'s experiment wizard:\n'
    + '• mode "edit" — ONE slideshow, same images, new overlay text. The copied hook and per-slide overlay strings go into '
    + '`direction` in the site\'s exact wording, with variables ["hook"], controlled mode, 2 variants and a 100-credit cap. '
    + 'Pass one overlayTexts entry per slide starting at slide 2 (empty string = strip that slide\'s text); trailing slides you '
    + 'leave out are left to the planner. slideCount is the SOURCE slide count (clamped 3-8); when the source slideshow has '
    + 'slides the server derives its own story count, so pass it only when you know it.\n'
    + '• mode "create" — 1 to 20 slideshows, testing the variables you name: hook, character, visualStyle, caption, cta, or '
    + 'angle (a new story). Angle/concept forces exploration mode; every other combination stays controlled, where each '
    + 'variant must change exactly one approved variable.\n'
    + 'Only slideshows qualify — a plain video post is rejected with video_not_slideshow. See show_gallery for eligible videos.',
    {
      workspaceId: workspaceIdField,
      mode: z.enum(['edit', 'create']).default('create')
        .describe('"edit" = same images, new overlay text (one video). "create" (default) = new variations.'),
      // edit mode
      videoId: S.Id.optional().describe('EDIT mode: the one slideshow whose overlay text is being replaced.'),
      hook: z.string().trim().max(200).optional()
        .describe('EDIT mode: the exact words for slide 1. May be empty if you are replacing a supporting slide\'s text instead.'),
      overlayTexts: z.array(z.string().max(200)).max(7).optional()
        .describe('EDIT mode: overlay text for slides 2, 3, … in order. Empty string = strip that slide\'s text.'),
      // create mode
      videoIds: z.array(S.Id).min(1).max(20).optional()
        .describe('CREATE mode: the slideshows to vary, 1 to 20 (use show_gallery to find eligible ids).'),
      goal: z.string().trim().max(2000).optional()
        .describe('CREATE mode: what the variations should beat, in the user\'s words. Doubles as the experiment title.'),
      variables: z.array(z.enum([...S.VARIABLE_FIELDS, 'angle' as const])).min(1).max(7).optional()
        .describe('CREATE mode: what to vary. "angle" is the site\'s name for a concept/retell and forces exploration.'),
      variantCount: z.number().int().min(1).max(12).default(3).describe('CREATE mode: variants to produce, 1-12 (default 3).'),
      maxCredits: z.number().int().min(1).max(10_000).default(200)
        .describe('CREATE mode: runaway guard for this experiment, 1-10000 (default 200). Real spend is the estimate you approve.'),
      // shared
      slideCount: z.number().int().min(1).max(20).optional()
        .describe('Source slide count, clamped to 3-8. Only used when the source has no slides to derive from. Defaults to 5.'),
      direction: z.string().trim().max(2000).optional().describe('CREATE mode: creative direction for the planner (optional).'),
      brand: z.string().trim().max(2000).optional().describe('CREATE mode: brand context (optional).'),
      audience: z.string().trim().max(2000).optional().describe('CREATE mode: audience (optional).'),
      language: z.string().trim().min(1).max(80).default('English').describe('Output language for the copy (default English).'),
      lockedConstraints: z.array(z.string().trim().min(1).max(2000)).max(20).optional()
        .describe('CREATE mode: strings every variant must keep verbatim (e.g. "no health claims"). Must match across all variants.'),
    },
    async ({ workspaceId, mode, videoId, hook, overlayTexts, videoIds, goal, variables, variantCount, maxCredits, slideCount, direction, brand, audience, language, lockedConstraints }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const instructions = mode === 'edit'
        ? editInstructions({ hook, overlayTexts: overlayTexts ?? [], language })
        : createInstructions({ goal, variables, direction, brand, audience, language, lockedConstraints });

      const payloadBody = mode === 'edit'
        ? {
          videoIds: [requireOne(videoId, 'videoId')],
          instructions,
          // Edit mode is pinned to the site's shape: one hook test, two variants,
          // 100 credits.
          variantCount: EDIT_VARIANT_COUNT,
          slideCount: clampSlideCount(slideCount ?? DEFAULT_SLIDE_COUNT),
          maxCredits: EDIT_MAX_CREDITS,
        }
        : {
          videoIds: requireList(videoIds, 'videoIds'),
          instructions,
          variantCount,
          slideCount: clampSlideCount(slideCount ?? DEFAULT_SLIDE_COUNT),
          maxCredits,
        };

      const created = await createExperiment({ ...payloadBody, workspaceId: workspace.id, idempotencyKey: randomUUID() });
      // Same shape the gallery survey route returns: the draft plus the
      // plan-stage price, so the cost is on screen before anything is spent.
      const planQuote = await estimate(created, 'plan');
      return payload(withNextSteps({
        experiment: serialize(created),
        spendNote: 'Draft only — this call charged nothing.',
        estimate: { plan: planQuote },
        cost: costBlock(0, { quoted: true, remaining: planQuote.workspaceCredits, note: 'Nothing charged. Planning and generating are separate, explicitly priced calls.' }),
      }, lifecycleSteps(created, planQuote)));
    }));

  // ── price (free) ────────────────────────────────────────────────────────

  server.tool('estimate_experiment',
    'Price the NEXT spending step of an experiment without taking it. Free; no credits charged. '
    + 'stage "plan" prices analysis + report + briefs for the whole experiment. stage "generate" prices rendering the '
    + 'variants you name (omit variantIds to price all of them). Pass taskIds instead to price a retry of specific jobs. '
    + 'Call this before plan_experiment, generate_experiment and retry_experiment and show the user the number.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id.'),
      stage: S.Estimate.shape.stage.describe('Which step to price.'),
      variantIds: S.Estimate.shape.variantIds.describe('GENERATE only: variants to price (default: all of them).'),
      taskIds: S.Estimate.shape.taskIds.describe('Price a retry of exactly these jobs (from get_experiment → jobs[].id).'),
    },
    async ({ workspaceId, experimentId, stage, variantIds, taskIds }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const e = await load(workspace.id, experimentId);
      // Estimate.parse is reused so the strict rule (taskIds is a per-job
      // price, variantIds are generation-only) is enforced here exactly as on
      // the REST route.
      const parsed = S.Estimate.parse({ workspaceId: workspace.id, stage, variantIds, taskIds });
      const quote = await estimate(e, parsed.stage, parsed.variantIds, parsed.taskIds);
      const spendsTool = parsed.taskIds ? 'retry_experiment' : parsed.stage === 'plan' ? 'plan_experiment' : 'generate_experiment';
      return payload(withNextSteps({
        experimentId: e.id,
        status: e.status,
        estimate: quote,
        cost: costBlock(0, { quoted: true, remaining: quote.workspaceCredits, note: 'Quote only — nothing charged. A quote is an estimate, not a cap: the experiment budget is the hard limit.' }),
      }, [
        { label: `Run ${spendsTool}`, tool: spendsTool, args: { experimentId: e.id }, cost: creditLabel(quote.totalCredits), spendsMoney: true, why: 'The step this price is for. Confirm the cost with the user first.' },
      ]));
    }));

  // ── transitions that spend ──────────────────────────────────────────────

  server.tool('plan_experiment',
    'Start planning a draft experiment: the worker analyses the source slideshows, writes the report and proposes the '
    + 'variants. SPENDS CREDITS as those steps run, up to the estimate returned here — the response carries that estimate '
    + 'before the transition, so show the user the number first. Only a draft can be planned (not_draft). '
    + 'idempotencyKey makes a retried call replay instead of paying twice; reuse the key from the response for a genuine retry. '
    + 'Planning is asynchronous: poll get_experiment (free) until status is "review" — do not re-call this tool.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id (status must be draft).'),
      idempotencyKey: S.Command.shape.idempotencyKey.default(() => randomUUID())
        .describe('Replaying the same key returns the same result instead of planning (and paying) twice.'),
      allowPartial: S.Plan.shape.allowPartial.describe('Accept a degraded plan — fewer variants than requested if the fan-out cannot fill variantCount. Default false.'),
    },
    async ({ workspaceId, experimentId, idempotencyKey, allowPartial }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const before = await load(workspace.id, experimentId);
      // Quote BEFORE the transition: after it, the inputs and report are already
      // on their way and the estimate would read as zero.
      const quote = await estimate(before, 'plan');
      const next = await mutate(workspace.id, experimentId, 'plan', { workspaceId: workspace.id, idempotencyKey, allowPartial });
      return payload(withNextSteps({
        experiment: serialize(next),
        idempotencyKey,
        estimate: { plan: quote },
        cost: costBlock(0, { quoted: true, remaining: quote.workspaceCredits, note: 'Queued work: analysis, report and briefs debit credits as the worker runs them, up to this estimate.' }),
      }, lifecycleSteps(next, quote)));
    }));

  server.tool('generate_experiment',
    'Render the variants you name from a planned experiment. This is the LARGEST charge in the lifecycle (every slide of every '
    + 'variant is rendered) and it SPENDS CREDITS, so the response carries the generate-stage estimate before the transition — '
    + 'show the user that number and get an explicit yes before calling this; price it first with the free estimate_experiment. '
    + 'Each variant must be passed with the `revision` you read from '
    + 'get_experiment: a stale revision is refused with revision_conflict rather than rendering the wrong brief. '
    + 'Use idempotencyKey to make a retried call replay instead of paying twice.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id (status must be review).'),
      variants: S.Generate.shape.variants
        .describe('The variants to render, each as { id, revision } exactly as read from get_experiment.'),
      idempotencyKey: S.Command.shape.idempotencyKey.default(() => randomUUID())
        .describe('Replaying the same key returns the same result instead of rendering (and paying) twice.'),
    },
    async ({ workspaceId, experimentId, variants, idempotencyKey }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const before = await load(workspace.id, experimentId);
      const choice = S.Generate.parse({ workspaceId: workspace.id, idempotencyKey, variants }).variants;
      const quote = await estimate(before, 'generate', choice.map(v => v.id));
      const next = await mutate(workspace.id, experimentId, 'generate', { workspaceId: workspace.id, variants: choice, idempotencyKey });
      return payload(withNextSteps({
        experiment: serialize(next),
        idempotencyKey,
        estimate: { generate: quote },
        cost: costBlock(0, { quoted: true, remaining: quote.workspaceCredits, note: 'Rendering debits credits slide by slide as the worker runs, up to this estimate.' }),
      }, lifecycleSteps(next, quote)));
    }));

  server.tool('retry_experiment',
    'Re-submit the work an experiment failed or paused on. SPENDS CREDITS for every job it re-submits — each retry is charged '
    + 'again, so price it first with estimate_experiment(taskIds) and get the user\'s yes. Name taskIds for specific jobs '
    + '(the precise choice: get_experiment → jobs[] shows which failed), or variantIds to retry that variant\'s failed slides. '
    + 'Omit both to retry everything that failed. Jobs whose provider outcome is genuinely unknown are retried too — a lost '
    + 'response costs at most one more charge. Refused with retry_limit once a job has burned all its attempts.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id (status must be failed or paused).'),
      taskIds: S.Retry.shape.taskIds.describe('Retry exactly these jobs (get_experiment → jobs[].id).'),
      variantIds: S.Retry.shape.variantIds.describe('Retry the failed slides of these variants.'),
      idempotencyKey: S.Command.shape.idempotencyKey.default(() => randomUUID())
        .describe('Replaying the same key returns the same result instead of re-submitting (and re-paying) twice.'),
    },
    async ({ workspaceId, experimentId, taskIds, variantIds, idempotencyKey }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const before = await load(workspace.id, experimentId);
      const quote = await estimate(before, 'generate', taskIds ? undefined : variantIds, taskIds);
      const next = await mutate(workspace.id, experimentId, 'retry', { workspaceId: workspace.id, idempotencyKey, taskIds, variantIds });
      return payload(withNextSteps({
        experiment: serialize(next),
        idempotencyKey,
        estimate: { retry: quote },
        cost: costBlock(0, { quoted: true, remaining: quote.workspaceCredits, note: 'Each re-submitted job is charged again as the worker runs it, up to this estimate.' }),
      }, lifecycleSteps(next, quote)));
    }));

  // ── free transitions ────────────────────────────────────────────────────

  server.tool('cancel_experiment',
    'Cancel an experiment: no further work is started, and any variant that was generating becomes cancelled. '
    + 'Free — cancelling never charges, and credits already spent on completed jobs are NOT refunded. '
    + 'A cancelled experiment can still be read and deleted, but cannot be planned or generated.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id.'),
      idempotencyKey: S.Command.shape.idempotencyKey.default(() => randomUUID())
        .describe('Replaying the same key returns the same result instead of re-cancelling.'),
    },
    async ({ workspaceId, experimentId, idempotencyKey }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const next = await mutate(workspace.id, experimentId, 'cancel', { workspaceId: workspace.id, idempotencyKey });
      return payload(withNextSteps({
        experiment: serialize(next),
        idempotencyKey,
        cost: costBlock(0, { remaining: next.maxCredits - next.creditsCharged, note: 'Cancelled — nothing charged, nothing refunded.' }),
      }, lifecycleSteps(next)));
    }));

  server.tool('edit_experiment_variant',
    'Rewrite one variant\'s brief while the experiment sits in review, before any rendering is paid for. Free — this is the '
    + 'cheap way to fix a plan you do not like. The whole brief is replaced, so start from get_experiment and change only what '
    + 'you mean to change. Two rules are enforced: the brief must keep the experiment\'s slide count and lockedConstraints, and '
    + 'after your edit every variant must still differ from the baseline in exactly the variables the experiment approved. '
    + 'Pass the `revision` you read; a stale one is refused with revision_conflict. The variant is frozen once rendering starts.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id (status must be review).'),
      variantId: S.Id.describe('Variant id (get_experiment → variants[].id).'),
      revision: S.EditBrief.shape.revision.describe('The variant revision you read. A stale revision is refused with revision_conflict.'),
      brief: S.Brief.describe('The replacement brief: concept, hook, character, visualStyle, caption, cta, lockedConstraints and 3-8 slides.'),
    },
    async ({ workspaceId, experimentId, variantId, revision, brief }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      // mutate() re-parses with EditBrief and bumps the revision, so the edit is
      // validated and versioned by exactly the REST rule.
      const next = await mutate(workspace.id, experimentId, 'edit', { workspaceId: workspace.id, revision, brief }, variantId);
      const edited = next.variants.find(v => v.id === variantId);
      return payload(withNextSteps({
        experiment: serialize(next),
        editedVariant: edited ? { id: edited.id, revision: edited.revision, title: edited.title } : null,
        note: 'Read the new revision from get_experiment before generating — generation requires it.',
        cost: costBlock(0, { remaining: next.maxCredits - next.creditsCharged, note: 'Editing is free — nothing charged.' }),
      }, lifecycleSteps(next)));
    }));

  server.tool('delete_experiment',
    'Delete an experiment permanently: the record AND every retained slide image it produced. Free in credits, but NOT '
    + 'reversible — a deleted experiment cannot be re-planned or re-rendered. A planning or generating experiment must be '
    + 'cancelled first (active_experiment). Read the experiment before deleting it if the user has not just been shown it.',
    {
      workspaceId: workspaceIdField,
      experimentId: S.Id.describe('Experiment id. Must not be planning or generating.'),
    },
    async ({ workspaceId, experimentId }) => attempt(async () => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const e = await load(workspace.id, experimentId);
      if (e.status === 'planning' || e.status === 'generating') {
        throw new S.ExperimentError(409, 'active_experiment', 'Cancel the experiment before deleting it.');
      }
      const paths = retainedPaths(e);
      const deleted = await remove(workspace.id, experimentId);
      if (!deleted) throw new S.ExperimentError(404, 'experiment_not_found');
      // Best-effort image cleanup: an orphaned object costs storage, a failed
      // deletion of a deleted row must not read as a failed delete.
      const imagesRemoved = paths.length ? await deleteObjects(thumbBucket(), paths).catch(() => 0) : 0;
      return payload({
        experimentId,
        deleted: true,
        imagesRemoved,
        cost: costBlock(0, { note: 'Deleted — nothing charged. Retained images removed with the record.' }),
      });
    }));
}

/** Slide count clamp shared with the site wizard (data-slide-count → 3..8). */
export function clampSlideCount(n: number): number {
  return Math.min(8, Math.max(3, Math.trunc(n)));
}

function requireOne(value: string | undefined, field: string): string {
  if (!value) throw new S.ExperimentError(422, 'invalid_request', `mode "edit" needs ${field} — edit mode works on exactly one slideshow.`);
  return value;
}

function requireList(values: string[] | undefined, field: string): string[] {
  if (!values?.length) throw new S.ExperimentError(422, 'invalid_request', `mode "create" needs ${field} — pick 1 to 20 slideshows (show_gallery lists eligible ones).`);
  return values;
}

/**
 * Edit-mode instructions, byte-for-byte the site's payload (src/ui/gallery.ts
 * `buildPayload`).
 *
 * The planner is the only thing that will ever see these strings, so the hook
 * and each per-slide overlay are quoted inline with the slide they belong to:
 * slide 1 is the tested hook variable, slides 2..N are the supporting copy. The
 * "(strip — no text)" suffix is what tells the planner an empty string means
 * render no text at all, which is not the same as "leave the original".
 */
export function editInstructions(input: { hook?: string; overlayTexts: string[]; language?: string }): S.InstructionsData {
  const hook = (input.hook ?? '').trim();
  const overlays = input.overlayTexts;
  if (!hook && overlays.length === 0) {
    throw new S.ExperimentError(422, 'invalid_request', 'Nothing to change: give a hook for slide 1, or at least one overlayTexts entry for slide 2 onwards.');
  }
  const lines = [`Slide 1 (hook): "${hook}" (empty clears it too)`];
  overlays.forEach((text, i) => {
    const trimmed = text.trim();
    lines.push(`Slide ${i + 2}: "${trimmed}"${trimmed ? '' : ' (strip — no text)'}`);
  });
  return {
    goal: EDIT_GOAL,
    brand: '',
    audience: '',
    language: input.language?.trim() || 'English',
    direction: 'Render the exact overlay texts. ' + lines.join(' '),
    lockedConstraints: [],
    variables: ['hook'],
    mode: 'controlled',
  };
}

/**
 * Create-mode instructions. `angle` is the site's name for concept/retell and
 * forces exploration — the schema would reject it as controlled anyway, so the
 * mode is derived here rather than making the caller remember.
 */
export function createInstructions(input: {
  goal?: string; variables?: Array<string>; direction?: string; brand?: string;
  audience?: string; language?: string; lockedConstraints?: string[];
}): S.InstructionsData {
  const variables = input.variables ?? [];
  if (!input.goal?.trim()) throw new S.ExperimentError(422, 'invalid_request', 'mode "create" needs a goal — what should the variations beat?');
  if (!variables.length) throw new S.ExperimentError(422, 'invalid_request', 'mode "create" needs at least one variable to test.');
  const exploratory = variables.some(v => v === 'concept' || v === 'angle' || v === 'slides');
  return {
    goal: input.goal.trim(),
    brand: input.brand?.trim() ?? '',
    audience: input.audience?.trim() ?? '',
    language: input.language?.trim() || 'English',
    direction: input.direction?.trim() ?? '',
    lockedConstraints: input.lockedConstraints ?? [],
    variables: variables as S.InstructionsData['variables'],
    mode: exploratory ? 'exploration' : 'controlled',
  };
}