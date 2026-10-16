import { randomUUID, createHash } from 'node:crypto';
import type { Video } from '@prisma/client';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { CREDIT_COSTS, creditBalance } from '../lib/credits.js';
import * as S from './schema.js';
import * as store from './store.js';
import { compatibleInput } from './providers.js';
import { experimentSourceKeys, hasExperimentSlides, isPhotoPost } from '../lib/media.js';
import { persistedOverlayText } from './render-prompt.js';
import { deriveStorySlideCount } from './slide-count.js';
import { applyApprovedEstimate } from './budget.js';
import { resolveCompositeSource } from './composite/resolve.js';
import type { DeckRequest } from './composite/options.js';
import { compileExactEdit } from './exact-edit.js';
import { applyFeedback, applyRevise, briefToArm, FALLBACK_HOOK, generationTasks, hookForOverlay, isContractPipeline, isEditArm, isScriptOverlay, reviseTargets, slideUnits, slideWorkFor } from './contract-flow.js';
import { slideWork } from './resolved-contract.js';
import { postKey } from '../lib/post-key.js';
import { expandPreset, inferSharedFormat, type WorkspaceCategory } from './source-format.js';
import { workspaceCategoryOf } from './workspace-category.js';
import { assertPublicHttpsUrl } from '../lib/webhook-url.js';

export const fingerprint = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Compact view count for experiment title differentiators: 8200000 -> 8.2M, 75600 -> 75.6k. */
export function formatCompactViews(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`.replace(/\.0k$/, 'k');
  return String(n);
}
/** One-line source summary for experiment titles: `@handle · caption snippet (views)`. */
export function sourceTag(v: { creatorHandle?: string | null; caption?: string | null; views?: number | null }): string {
  const handle = v.creatorHandle ? `@${v.creatorHandle}` : 'untitled';
  const flat = String(v.caption ?? '').replace(/\s+/g, ' ').trim();
  const snippet = flat ? (flat.length > 42 ? flat.slice(0, 42).replace(/\s+\S*$/, '') || flat.slice(0, 42) : flat) : 'untitled';
  const views = typeof v.views === 'number' ? ` (${formatCompactViews(v.views)})` : '';
  return `${handle} · ${snippet}${views}`;
}
/** Actions that belong exclusively to the versioned exact_edit operation. */
export const EXACT_EDIT_ACTIONS = new Set(['exact-edit']);
/** An explicit opt-in marker: a legacy create/edit body carries no `operation`,
 *  so it can never reach the exact_edit path. */
export function isExactEditRequest(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { operation?: unknown }).operation === S.EXACT_EDIT_OPERATION;
}

/**
 * SLA-451: create one source-preserving exact_edit deck.
 *
 * A separate entry point rather than a flag on the legacy create: no planner, no
 * briefs, no ranking, no selector, no variant fan-out, no credits. The contract is
 * compiled BEFORE any row exists, so a preparation failure never leaves a
 * half-prepared experiment behind.
 */
export async function createExactEdit(rawWithRunnerAndTest: unknown) {
  const { body: rawWithRunner, testKey, testMaxCredits } = S.takeTest(rawWithRunnerAndTest);
  const { body: raw, ranBy } = S.takeRanBy(rawWithRunner);
  const b = S.ExactEditRequest.parse(raw);
  const now = new Date().toISOString();
  const contract = compileExactEdit(b);
  const v = await db.video.findFirst({ where: { id: b.source.videoId, source: { workspaceId: b.workspaceId } } });
  if (!v) throw new S.ExperimentError(404,'video_not_found');
  if (!isPhotoPost(v) && !hasExperimentSlides(v.rawJson)) throw new S.ExperimentError(400,'video_not_slideshow','Only slideshows can be edited.');
  return store.create({
    id: randomUUID(), workspaceId: b.workspaceId, status: 'review', createdAt: now, updatedAt: now, ranBy, testKey, testMaxCredits,
    instructions: {
      goal: `exact_edit: preserve the source deck and change only the approved ${contract.openerEdit ? 'opener overlay' : 'per-slide copy'}.`,
      brand: '', audience: '', language: 'English',
      direction: `Exact edit of ${contract.slides.length} mapped source slide(s) under contract ${contract.contractId}.`,
      lockedConstraints: contract.locks.locked.map(String), variables: ['hook'], mode: 'controlled',
    },
    operation: { kind: S.EXACT_EDIT_OPERATION, contractVersion: contract.contractVersion },
    exactEdit: contract,
    // One deck, one variant. No alternatives are drafted or ranked, so there is
    // no baseline sibling and no selector record on this row.
    variants: [], variantCount: contract.variantCount, slideCount: contract.slides.length,
    maxCredits: 0, creditsCharged: 0, report: null, error: null,
    inputs: [await compatibleInput(v)],
    generationBasis: 'source-referenced',
    assetPolicy: 'Generated outputs retained until explicit deletion; never swept with source media. No Stream copies.',
    version: 0, tasks: [], commands: {}, allowPartial: false,
    notices: ['exact_edit: one deck, one variant, no alternatives were generated.'],
    createFingerprint: fingerprint(b),
  }, b.idempotencyKey);
}

/**
 * Every store access `createExperiment` makes, behind one seam. The default is
 * the live database; a caller that needs a different source (a test replaying a
 * stored draft, in particular) passes its own. Same shape as `renderDeps` in
 * providers.ts, and for the same reason: a process-global `mock.module` on
 * `../db.js` is shared with other suites and this file must not depend on it
 * (docs/test-suite-policy.md).
 */
export type CreateExperimentDeps = {
  findSource: (workspaceId: string, videoId: string) => Promise<Video | null>;
  findLatestAnalysis: (videoId: string) => Promise<{ analysisJson: string } | null>;
  buildInput: (video: Video) => Promise<S.Input>;
  /** SLA-868: swap a photo-annotation video for its code-rendered composite deck, or queue the render and throw `composite_deck_pending`. */
  resolveComposite?: (workspaceId: string, video: Video, request: DeckRequest, opts?: { replaceAiDeck?: boolean }) => Promise<Video>;
  persist: (experiment: S.Experiment, idempotencyKey: string, run?: store.Run, notify?: S.NotifyConfig | null) => Promise<S.Experiment>;
  /** SLA-885: the workspace's content category, which decides whether the real-people lock is emitted. Absent = general. */
  workspaceCategory?: (workspaceId: string) => Promise<WorkspaceCategory>;
};
export const createDeps: CreateExperimentDeps = {
  findSource: (workspaceId, videoId) => db.video.findFirst({ where: { id: videoId, source: { workspaceId } } }),
  findLatestAnalysis: (videoId) => db.analysis.findFirst({ where: { videoId, schemaVersion: 'v3' }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } }),
  buildInput: compatibleInput,
  resolveComposite: (workspaceId, video, request, opts) => resolveCompositeSource(workspaceId, video, request, undefined, opts),
  persist: store.create,
  workspaceCategory: workspaceCategoryOf,
};
export interface CreateExperimentOptions {
  /** False for source-preserving copy/character edits: they carry their own complete
   *  instructions and must not pick up a source-format preset's locks. */
  expandFormat?: boolean;
  /** Append the source tag (handle, caption snippet, views) to the stored goal. Default true: the site's list titles rely on it; the MCP tool turns it off. */
  tagGoal?: boolean;
  /** Brief-only experiment: no source video, the direction is the spec. Takes a body with no videoIds. */
  sourceless?: boolean;
  /** SLA-868: composite-deck knobs (feature, face subset, ✅/❌ order, score card, seed) and the direction a feature may be named in. */
  composite?: DeckRequest;
}
export async function createExperiment(rawWithRunnerAndNotify: unknown, deps: CreateExperimentDeps = createDeps, options: CreateExperimentOptions = {}) {
  const { body: rawWithRunner, notify: notifyRaw } = S.takeNotify(rawWithRunnerAndNotify);
  const { body: rawWithTest, ranBy } = S.takeRanBy(rawWithRunner);
  // SLA-806: the test key and test-wide cap stay out of the fingerprint, like ran_by: a retry that adds them is the same request.
  const { body: raw, testKey, testMaxCredits } = S.takeTest(rawWithTest);
  // Completion webhook target: refused before any source lookup or write so a bad URL never costs a row.
  const notify = S.parseNotify(notifyRaw, assertPublicHttpsUrl);
  // Legacy create: the two-variant planner path, unchanged. An exact_edit body
  // has its own entry point and must not be coerced through this schema.
  if (isExactEditRequest(raw)) throw new S.ExperimentError(409,'exact_edit_requires_exact_edit_action','Create an exact_edit deck with create_exact_edit; it does not use the legacy planner.');
  // SLA-555: instructions may omit variables/mode/direction/locks when a source
  // format fills them, and the format can be inferred from the sources' analysis,
  // so the strict instructions parse runs after the sources load. The idempotency
  // fingerprint is taken from the request as sent: an analysis that lands between
  // two identical calls must not turn the retry into an idempotency conflict.
  const sourceless = options.sourceless === true;
  const expandFormat = options.expandFormat !== false;
  const requested = sourceless ? S.CreateBriefRequest.parse(raw) : expandFormat ? S.CreateRequest.parse(raw) : null;
  const strict = requested ? null : S.Create.parse(raw);
  const head = requested ?? strict!;
  const requestFingerprint = fingerprint(head);
  const now = new Date().toISOString();
  const inputs: S.Input[] = [];
  let referenced = false;
  const slideSources: Array<{ originalCount: number | null; analysis?: unknown; caption?: string | null }> = [];
  const tags: string[] = [];
  const posts = new Set<string>();
  for (const videoId of head.videoIds) {
    let v = await deps.findSource(head.workspaceId, videoId);
    if (!v) throw new S.ExperimentError(404,'video_not_found');
    if (deps.resolveComposite) v = await deps.resolveComposite(head.workspaceId, v, { ...options.composite, ...(head.instructions.direction ? { direction: head.instructions.direction } : {}) }, { replaceAiDeck: options.composite !== undefined });
    // The same TikTok post is stored once per source, so two video ids can be one post.
    const post = postKey(v);
    if (posts.has(post)) throw new S.ExperimentError(400,'duplicate_source_post','Two of the videoIds are the same post; pass it once.');
    posts.add(post);
    tags.push(sourceTag(v as { creatorHandle?: string | null; caption?: string | null; views?: number | null }));
    // Slideshows only: plain video posts are disabled for selection — the
    // analysis and render pipeline is carousel-based (slideshow+caption
    // evidence). A video with a Recreate deck counts as a slideshow: the
    // experiment picks up the recreated slides (preferred) or the original
    // carousel via experimentSourceKeys().
    if (!isPhotoPost(v) && !hasExperimentSlides(v.rawJson)) throw new S.ExperimentError(400,'video_not_slideshow','Only slideshows can be selected for experiments.');
    referenced = true;
    const originalCount = experimentSourceKeys(v.rawJson).length || null;
    let analysis: unknown;
    if (originalCount) {
      const row = await deps.findLatestAnalysis(v.id);
      if (row?.analysisJson) try { analysis = JSON.parse(row.analysisJson); } catch { /* ignore broken analysis JSON */ }
    }
    slideSources.push({ originalCount: originalCount || null, analysis, caption: (v as { caption?: string | null }).caption });
    inputs.push(await deps.buildInput(v));
  }
  let b: z.infer<typeof S.Create> = strict!;
  if (sourceless) {
    // No source to infer a format from: only an explicit sourceFormat expands a preset, and the brief's own variables default to the hook.
    const ri = requested!.instructions;
    const variables = ri.variables ?? ['hook' as const];
    const expanded = expandPreset(ri.sourceFormat ?? null, {
      variables, mode: ri.mode, direction: ri.direction, lockedConstraints: ri.lockedConstraints,
    }, false, await deps.workspaceCategory?.(head.workspaceId));
    const mode = ri.mode ?? (variables.some(v => v === 'concept' || v === 'slides') ? 'exploration' : expanded.mode);
    b = S.CreateBrief.parse({ ...requested, instructions: {
      ...ri, ...expanded, mode, sourceDefaults: expanded.sourceDefaults, ...(ri.sourceFormat ? { sourceFormat: ri.sourceFormat } : {}),
    } });
  } else if (requested) {
    const ri = requested.instructions;
    const signal = inferSharedFormat(slideSources);
    const format = ri.sourceFormat ?? signal?.format ?? null;
    const expanded = expandPreset(format, {
      variables: ri.variables, mode: ri.mode, direction: ri.direction, lockedConstraints: ri.lockedConstraints,
    }, signal?.observedHuman ?? false, await deps.workspaceCategory?.(head.workspaceId));
    const sourceDefaults = [...new Set([...(ri.sourceDefaults ?? []), ...expanded.sourceDefaults])].slice(0, 20);
    b = S.Create.parse({ ...requested, instructions: {
      ...ri, ...expanded, sourceDefaults, ...(format ? { sourceFormat: format } : {}),
    } });
  }
  // SLA-867: a morph (ladder) deck's labels are drawn in code; stored explicitly so every reader sees it.
  if (b.instructions.variables.includes('morph') && !b.instructions.overlayMode) b = { ...b, instructions: { ...b.instructions, overlayMode: 'script' } };
  const { idempotencyKey, videoIds, workspaceId, slideCount: requestedSlideCount, ...fields } = b;
  // Persisted count: SLA-476 — the source deck keeps its own closing CTA slide
  // only when the caller opted in. Both boundaries read the same flag off the
  // stored instructions, so planning cannot undo what creation persisted.
  const slideCount = deriveStorySlideCount(slideSources, fields.instructions.preserveSourceCtaSlide) ?? requestedSlideCount;
  // Each experiment is isolated per slideshow but the goal doubles as the list
  // title — identical goals are indistinguishable. Suffix a quick source
  // summary unless the caller already named the source (e.g. re-duplicates).
  if (tags.length && options.tagGoal !== false) {
    const suffix = tags.length === 1
      ? ` — ${tags[0]}`
      : ` — ${tags.slice(0, 2).join(' + ')}${tags.length > 2 ? ` +${tags.length - 2} more` : ''}`;
    const goal = fields.instructions.goal;
    const alreadyTagged = tags.some(t => {
      const handle = t.split(' ')[0];
      return handle && handle.startsWith('@') && goal.includes(handle);
    });
    if (!alreadyTagged && !goal.endsWith(suffix) && goal.length + suffix.length <= 2000) {
      fields.instructions = { ...fields.instructions, goal: `${goal}${suffix}` };
    }
  }
  const draft: S.Experiment = { id: randomUUID(),workspaceId,...fields,slideCount,status:'draft',createdAt:now,updatedAt:now,ranBy,testKey,testMaxCredits,
    creditsCharged:0,report:null,inputs,variants:[],error:null,
    // Slideshow sources are attached as visual references during rendering; video-only stays text-directed.
    generationBasis:referenced?'source-referenced':'text-directed',
    assetPolicy:'Generated outputs retained until explicit deletion; never swept with source media. No Stream copies. Gemini uploads named experiment-temp expire at provider in approximately 48h; reusable handles expire locally at 40h.',
    // SLA-700: every new experiment runs on the resolved-contract pipeline; rows without the marker keep the legacy one.
    pipeline:'contract',
    version:0,tasks:[],commands:{},allowPartial:false,createFingerprint:requestFingerprint };
  return notify ? deps.persist(draft,idempotencyKey,undefined,notify) : deps.persist(draft,idempotencyKey);
}
export interface DedupedVideoIds { videoIds: string[]; duplicates: Array<{ videoId: string; duplicateOf: string }> }
/**
 * SLA-555: collapse video ids that are the same post (platform + externalId). The
 * same post lands under a second id when two tracked sources both surface it, and
 * each id would otherwise get its own experiment (and its own paid analysis).
 * Within a group the already-analyzed id wins, then the first one listed. Ids that
 * are not in the workspace are left in place so the create call reports them.
 */
export async function dedupeSourcePosts(
  workspaceId: string, videoIds: string[],
  find: (workspaceId: string, ids: string[]) => Promise<Array<{ id: string; platform: string; externalId: string; analyzed: boolean }>> = findPostKeys,
): Promise<DedupedVideoIds> {
  const rows = new Map((await find(workspaceId, videoIds)).map(r => [r.id, r]));
  const winner = new Map<string, string>();
  for (const id of videoIds) {
    const r = rows.get(id);
    if (!r) continue;
    const key = postKey(r);
    const current = winner.get(key);
    if (!current || (r.analyzed && !rows.get(current)!.analyzed)) winner.set(key, id);
  }
  const kept: string[] = [];
  const duplicates: DedupedVideoIds['duplicates'] = [];
  for (const id of videoIds) {
    const r = rows.get(id);
    const owner = r ? winner.get(postKey(r))! : id;
    if (owner === id) kept.push(id); else duplicates.push({ videoId: id, duplicateOf: owner });
  }
  return { videoIds: kept, duplicates };
}
async function findPostKeys(workspaceId: string, ids: string[]) {
  const videos = await db.video.findMany({ where: { id: { in: ids }, source: { workspaceId } }, select: { id: true, platform: true, externalId: true } });
  const analyzed = new Set((await db.analysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true }, distinct: ['videoId'] })).map(a => a.videoId));
  return videos.map(v => ({ ...v, analyzed: analyzed.has(v.id) }));
}
function selected(e: S.Experiment, ids?: string[]) {
  if (ids && new Set(ids).size !== ids.length) throw new S.ExperimentError(400,'duplicate_variant');
  const variants = ids ? ids.map(id => { const v = e.variants.find(v => v.id===id); if (!v) throw new S.ExperimentError(404,'variant_not_found'); return v; }) : e.variants;
  return variants;
}
export function taskCost(t: Pick<S.Task,'kind'>) { return t.kind==='analysis' ? CREDIT_COSTS.analyzeVideo : t.kind==='slide' ? CREDIT_COSTS.experimentSlide : CREDIT_COSTS.experimentPlanningCall; }
/** Image-model calls the slides of `v` still need, by the same `slideUnits` the preparer charges. Before the briefs are frozen the
 *  planned briefs stand in; a variant that shares slides with a baseline generated alongside it copies or edits them. */
function contractSlideUnits(e: S.Experiment, v: S.Experiment['variants'][number], generating: readonly S.Experiment['variants'][number][]): number {
  const script = isScriptOverlay(e);
  if (v.slides.length && !v.frozenBrief) return v.slides.filter(s => s.status !== 'done').length;
  if (v.frozenBrief && v.slides.length) return v.slides.filter(s => s.status !== 'done').reduce((n, s) => n + slideUnits(slideWorkFor(e, v, s.index), script), 0);
  const base = v.baselineId ? e.variants.find(x => x.id === v.baselineId) : undefined;
  const shared = base && (generating.some(x => x.id === base.id) || base.slides.some(s => s.status === 'done'));
  if (!shared) return v.brief.slides.length;
  const a = briefToArm(base.brief), b = briefToArm(v.brief), edit = isEditArm(e, v);
  return v.brief.slides.reduce((n, _, i) => n + slideUnits(slideWork(a, b, i, edit), script), 0);
}
async function contractEstimate(e: S.Experiment, stage: 'plan'|'generate', variants: S.Experiment['variants'], taskIds?: string[]) {
  let analyses = 0, planningCalls = 0, renders = 0, qas = 0;
  if (taskIds) {
    const jobs = e.tasks.filter(t => new Set(taskIds).has(t.id) && t.status !== 'done');
    analyses = jobs.filter(t => t.kind === 'analysis').length; planningCalls = jobs.filter(t => t.kind === 'briefs').length;
    const script = isScriptOverlay(e);
    renders = jobs.filter(t => t.kind === 'slide').reduce((n, t) => {
      const v = e.variants.find(x => x.id === t.target);
      return n + (v?.frozenBrief ? slideUnits(slideWorkFor(e, v, t.index ?? 0, t.fix), script) : 1);
    }, 0);
    qas = jobs.filter(t => t.kind === 'qa').length;
  } else if (stage === 'plan') {
    analyses = e.inputs.filter(x => x.status !== 'ready').length; planningCalls = e.variants.length ? 0 : 1;
  } else {
    for (const v of variants) { renders += contractSlideUnits(e, v, variants); qas++; }
  }
  const quote = await contractPrice(e, { analyses, planningCalls, renders, qas, corrections: stage === 'generate' || !!taskIds });
  // Before the plan exists nobody knows how many slides each alternate really re-renders, so quote the ceiling: every alternate rendered and checked in full.
  if (stage === 'plan' && !taskIds && !e.variants.length) {
    const SL = CREDIT_COSTS.experimentSlide, PL = CREDIT_COSTS.experimentPlanningCall;
    return { ...quote, projectedGenerationCredits: e.variantCount * (e.slideCount * SL + PL), upperBound: true };
  }
  return quote;
}
async function contractPrice(e: S.Experiment, n: { analyses: number; planningCalls: number; renders: number; qas: number; corrections: boolean }) {
  const AN = CREDIT_COSTS.analyzeVideo, PL = CREDIT_COSTS.experimentPlanningCall, SL = CREDIT_COSTS.experimentSlide;
  const { analyses, planningCalls, renders, qas } = n;
  const analysisCredits = analyses * AN, planningCredits = planningCalls * PL, generationCredits = renders * SL + qas * PL;
  // One repair round can re-render every slide of an arm and re-check it; those are new tasks, charged like any other.
  const correctionCredits = n.corrections ? generationCredits : 0;
  return { analysisCredits, planningCredits, generationCredits, totalCredits: analysisCredits + planningCredits + generationCredits,
    correctionCredits, maxTotalCredits: analysisCredits + planningCredits + generationCredits + correctionCredits,
    remainingCredits: e.maxCredits - e.creditsCharged, workspaceCredits: (await creditBalance(e.workspaceId)).total,
    maxCredits: e.maxCredits, generationBasis: e.generationBasis, exactProviderUsdCap: false,
    maxProviderRequests: analyses + planningCalls + (renders + qas) * (correctionCredits ? 2 : 1),
    pricing: { analysis: AN, planningCall: PL, slide: SL },
    // Every contract slide renders exactly one candidate (fan-out 1), morph decks (SLA-867) included.
    candidatesPerSlide: 1 };
}
/** SLA-797: price one human feedback round — the slides it re-renders plus one QA of the arm, and the repair round QA may buy. */
export async function estimateFeedback(e: S.Experiment, raw: unknown) {
  const req = S.FeedbackRequest.parse(raw);
  // Price exactly what applyFeedback would queue, refusals included, on a scratch copy.
  const { redo } = applyFeedback(structuredClone(e), req);
  return { ...(await contractPrice(e, { analyses: 0, planningCalls: 0, renders: redo.length, qas: 1, corrections: true })), redo };
}
/** Price one brief revision: the rewrite call, then every arm rendered and QA-checked again (plus the repair round QA may buy). */
export async function estimateRevise(e: S.Experiment) {
  reviseTargets(e);
  const arms = e.variants;
  const renders = arms.reduce((n, v) => n + contractSlideUnits(e, v, arms), 0);
  return contractPrice(e, { analyses: 0, planningCalls: 1, renders, qas: arms.length, corrections: true });
}
export async function estimate(e: S.Experiment, stage: 'plan'|'generate'|'revise', ids?: string[], taskIds?: string[]) {
  if (stage === 'revise') {
    if (ids || taskIds) throw new S.ExperimentError(400,'revise_takes_no_scope');
    return estimateRevise(e);
  }
  if (stage === 'plan' && ids) throw new S.ExperimentError(400,'variantIds_only_for_generation');
  const variants = selected(e,ids);
  if (isContractPipeline(e)) return contractEstimate(e, stage, variants, taskIds);
  if (taskIds) {
    // Per-job retry estimate: price exactly the named jobs that still need provider work.
    const wanted = new Set(taskIds);
    const jobs = e.tasks.filter(t=>wanted.has(t.id)&&t.status!=='done');
    const priceOf = (t:S.Task)=>t.kind==='slide' ? CREDIT_COSTS.experimentSlide*S.slideFanout() : taskCost(t);
    const analysisCredits = jobs.filter(t=>t.kind==='analysis').reduce((n,t)=>n+priceOf(t),0);
    const planningCredits = jobs.filter(t=>t.kind==='report'||t.kind==='briefs').reduce((n,t)=>n+priceOf(t),0);
    const generationCredits = jobs.filter(t=>t.kind==='slide').reduce((n,t)=>n+priceOf(t),0);
    const correctionCredits = jobs.filter(t=>t.kind==='slide').length*CREDIT_COSTS.experimentSlide*S.slideFanout()*(S.qaMaxAttempts()-1);
    return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
      correctionCredits,maxTotalCredits:analysisCredits+planningCredits+generationCredits+correctionCredits,
      remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
      maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
      maxProviderRequests:jobs.reduce((n,t)=>n+(t.kind==='slide'?S.slideTaskRequestCap():1),0),
      pricing:{analysis:CREDIT_COSTS.analyzeVideo,planningCall:CREDIT_COSTS.experimentPlanningCall,slide:CREDIT_COSTS.experimentSlide} };
  }
  const analysisCredits = stage === 'plan' ? e.inputs.filter(x=>x.status!=='ready').length*CREDIT_COSTS.analyzeVideo : 0;
  const planningCredits = stage === 'plan' ? (e.report ? 0 : CREDIT_COSTS.experimentPlanningCall) + (e.variants.length ? 0 : CREDIT_COSTS.experimentPlanningCall) : 0;
  const generationCredits = stage === 'generate' ? variants.reduce((n,v)=>n+(v.slides.length ? v.slides.filter(s=>s.status!=='done').length : e.slideCount)*CREDIT_COSTS.experimentSlide,0)*S.slideFanout() : 0;
  // Every slide can buy up to qaMaxAttempts-1 more full fan-out waves; each is admitted against the
  // remaining experiment credit and the wallet before its provider calls, so this is a ceiling on
  // requests, never an amount charged up front.
  const correctionCredits = generationCredits*(S.qaMaxAttempts()-1);
  return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
    correctionCredits,maxTotalCredits:analysisCredits+planningCredits+generationCredits+correctionCredits,
    remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
    maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
    maxProviderRequests: (stage==='plan' ? analysisCredits/CREDIT_COSTS.analyzeVideo+planningCredits/CREDIT_COSTS.experimentPlanningCall : generationCredits/CREDIT_COSTS.experimentSlide/S.slideFanout()*S.slideTaskRequestCap()),
    pricing:{analysis:CREDIT_COSTS.analyzeVideo,planningCall:CREDIT_COSTS.experimentPlanningCall,slide:CREDIT_COSTS.experimentSlide} };
}
const task = (kind:S.Task['kind'], target?:string,index?:number):S.Task => ({id:randomUUID(),kind,target,index,status:'pending',attempts:0,charged:0});
/**
 * Requeue the named jobs and the slides they own (SLA-511).
 *
 * Pure with respect to `e`: no store access, so the transition a retry makes
 * visible is testable on its own, exactly like engine's `settle`.
 *
 * Clearing the SLIDE-level error is the point. The previous attempt's error is
 * what made this slide retryable, and the new attempt has not run yet, so
 * leaving it on the slide showed a queued slide still carrying a timeout that
 * never happened again — a live failure for work in flight. The evidence is
 * kept, but labelled as history: `qaHistory` holds prior attempts and `qa`
 * stays empty until THIS attempt returns a verdict. The historical record
 * drops the render prompt — the largest, least diagnostic field — so a
 * repeatedly retried slide cannot grow the stored document without bound
 * (document-budget.ts). Completed slides are not touched, and `attempts` keeps
 * counting so the manual-retry ceiling still holds.
 */
export function applyRetry(e:S.Experiment,retryTasks:readonly S.Task[]):void{
  // An explicit retry of a failed/unknown slide is priced by the per-job estimate and authorizes one more allowance;
  // a merely paused (pending) task keeps what it has left.
  for(const t of retryTasks){
    if(t.kind==='slide'&&t.status!=='pending')t.requestCap=(t.requests??0)+S.slideTaskRequestCap();
    t.status='pending';t.error=undefined;t.diagnostic=undefined;t.nextAttemptAt=undefined;
  }
  for(const v of e.variants){
    const vt=retryTasks.filter(t=>t.target===v.id);
    if(!vt.length) continue;
    v.status='generating';v.error=null;
    for(const t of vt) if(t.index!==undefined){
      const slide=v.slides[t.index];if(!slide) continue;
      slide.status='pending';
      slide.error=null;slide.diagnostic=null;
      if(slide.qa){
        const {prompt:_prompt,...record}=slide.qa;
        slide.qaHistory=[...(slide.qaHistory??[]),record].slice(-S.QA_HISTORY_LIMIT);
        slide.qa=null;
      }
    }
  }
}
/** The `retry` command: requeue the named jobs (or every failed one) and reopen the run. Pure with respect to `e`. */
export function retryJobs(e:S.Experiment,body:unknown):void{
  if(e.status!=='failed' && e.status!=='paused') throw new S.ExperimentError(409,'not_retryable');
  // Only genuinely in-flight leases block a retry; exhausted/unknown jobs are retryable
  // on demand (each retry re-charges, so a lost provider delivery costs at most one more).
  if(e.tasks.some(t=>t.status==='running')) throw new S.ExperimentError(409,'provider_outcome_unknown','A provider request is still in flight. Refresh and retry in a moment.');
  const {variantIds:ids,taskIds:wantedTaskIds}=S.Retry.parse(body);
  let retryTasks: S.Task[];
  if (wantedTaskIds) {
    const wanted = new Set(wantedTaskIds);
    // 'pending' included so an experiment paused by a transient guard can resume named work.
    retryTasks = e.tasks.filter(t=>wanted.has(t.id)&&(t.status==='failed'||t.status==='unknown'||t.status==='pending'));
    if (!retryTasks.length) throw new S.ExperimentError(409,'nothing_to_retry');
  } else {
    retryTasks = e.tasks.filter(t=>t.status==='failed' && (!ids || (t.kind==='slide' && ids.includes(t.target!))));
    if(!retryTasks.length) throw new S.ExperimentError(409,'nothing_to_retry');
    if(ids) selected(e,ids);
  }
  if(retryTasks.some(t=>t.attempts>=S.MAX_MANUAL_ATTEMPTS)) throw new S.ExperimentError(409,'retry_limit');
  applyRetry(e,retryTasks);
  e.error=null;e.status=(isContractPipeline(e)||e.report)&&e.variants.length?'generating':'planning';
}
/**
 * Brief-edit matrix for `update_experiment_variant`. Throws unless the variant's brief may be rewritten.
 *   review            draft variant        edit
 *   completed         draft variant        edit (a rendered/frozen variant never)
 *   failed | paused   draft variant        edit only while no in-flight/unknown provider job could resume from it
 *   draft             no variants yet      refused: not_editable (plan first)
 *   planning | generating                  refused: experiment_active
 *   cancelled                              refused: experiment_cancelled
 * A frozen or non-draft variant is variant_frozen; a stale revision is revision_conflict.
 */
export function assertVariantEditable(e:S.Experiment,variantId:string|undefined,revision:number):S.Experiment['variants'][number] {
  if (!variantId) throw new S.ExperimentError(400,'variant_required','Name the variant to edit.');
  switch (e.status) {
    case 'planning': case 'generating': throw new S.ExperimentError(409,'experiment_active');
    case 'cancelled': throw new S.ExperimentError(409,'experiment_cancelled');
    case 'draft': throw new S.ExperimentError(409,'not_editable');
    case 'review': case 'completed': case 'failed': case 'paused': break;
    default: throw new S.ExperimentError(409,'not_editable');
  }
  const v=selected(e,[variantId])[0]!;
  if (v.status!=='draft' || v.frozenBrief) throw new S.ExperimentError(409,'variant_frozen');
  if (v.revision!==revision) throw new S.ExperimentError(409,'revision_conflict');
  if ((e.status==='failed' || e.status==='paused') && e.tasks.some(t=>(t.status==='running'||t.status==='unknown') && (t.kind!=='slide' || t.target===v.id)))
    throw new S.ExperimentError(409,'variant_in_flight');
  return v;
}
/**
 * The contract pipeline renders the hook from slides[0].overlayText and ignores brief.hook, so the two must
 * never disagree after an edit. Whichever one the caller changed wins (a blank caption stores the placeholder
 * hook); changing both to different texts is ambiguous and refused rather than guessed.
 */
function reconcileContractHook(prior:S.BriefData,brief:S.BriefData):S.BriefData {
  const first=brief.slides[0]; if(!first) return brief;
  const overlay=first.overlayText??'';
  const overlayChanged=overlay!==(prior.slides[0]?.overlayText??'');
  const hookChanged=brief.hook!==prior.hook;
  const hookText=brief.hook===FALLBACK_HOOK?'':brief.hook;
  if(overlayChanged&&hookChanged&&hookText!==overlay)
    throw new S.ExperimentError(422,'hook_overlay_conflict',"On the slide-contract pipeline the hook is the first slide's caption. brief.hook and slides[0].overlayText were both changed to different texts; send the same text in both, or change only one.");
  if(overlayChanged) return {...brief,hook:hookForOverlay(overlay)};
  if(hookChanged) return {...brief,slides:brief.slides.map((s,i)=>i===0?{...s,overlayText:hookText}:s)};
  return brief;
}
/**
 * Apply an `update_experiment_variant` edit. Fields the experiment did not approve as
 * variables must be identical across variants, so a change to one is mirrored onto the other
 * draft variants (their revision advances); otherwise a coordinated rewrite (new topic, CTA,
 * caption) could never pass validation one variant at a time. Throws before mutating anything
 * when the result would break the one-variable contract.
 */
export function applyVariantEdit(e:S.Experiment,variantId:string|undefined,edit:z.infer<typeof S.EditBrief>) {
  const v=assertVariantEditable(e,variantId,edit.revision);
  // Slide contract fields are a partial merge: an omitted one keeps the stored slide's value.
  edit={...edit,brief:{...edit.brief,slides:edit.brief.slides.map((s,i)=>{
    const prior=v.brief.slides[i];
    return prior?{...(prior.composition!==undefined?{composition:prior.composition}:{}),...(prior.visibleChange!==undefined?{visibleChange:prior.visibleChange}:{}),...(prior.arcLevel!==undefined?{arcLevel:prior.arcLevel}:{}),...(prior.morph!==undefined?{morph:prior.morph}:{}),...s}:s;
  })}};
  // One text field: on the contract pipeline the hook is the first slide's caption, never a second copy.
  if(isContractPipeline(e)) edit={...edit,brief:reconcileContractHook(v.brief,edit.brief)};
  S.assertBrief(e,edit.brief,isContractPipeline(e)?v.brief.slides.length:e.slideCount);
  const mirroredTo=new Set<string>();
  const proposals=e.variants.map(p=>p.id===v.id?{...p,brief:edit.brief}:{...p});
  // With hook a variable, each contract arm owns its first-slide caption: it is the one slides[] field that never mirrors.
  // With scene a variable, each arm owns the scene of every slide in the same way.
  const ownCaption=isContractPipeline(e)&&e.instructions.variables.includes('hook');
  const ownScene=isContractPipeline(e)&&e.instructions.variables.includes('scene');
  const ownSlides=ownCaption||ownScene;
  const withOwnOf=(slides:S.BriefData['slides'],own:S.BriefData['slides'])=>slides.map((s,i)=>({...s,
    ...(i===0&&ownCaption&&own[0]?{overlayText:own[0].overlayText}:{}),...(ownScene&&own[i]?{scene:own[i]!.scene}:{})}));
  for(const k of S.sharedBriefFields(e)) {
    const next=(p:{brief:S.BriefData})=>k==='slides'&&ownSlides?withOwnOf(structuredClone(edit.brief.slides),p.brief.slides):structuredClone(edit.brief[k]);
    if(k==='slides'&&ownSlides?S.same(withOwnOf(v.brief.slides,edit.brief.slides),edit.brief.slides):S.same(v.brief[k],edit.brief[k])) continue;
    for(const p of proposals) {
      if(p.id===v.id || p.status!=='draft' || p.frozenBrief) continue;
      const value=next(p);
      if(k==='slides'&&ownSlides&&S.same(value,p.brief.slides)) continue;
      p.brief={...p.brief,[k]:value}; mirroredTo.add(p.id);
    }
  }
  // Derive factual delta labels rather than accepting stale model labels after editing.
  for(let i=1;i<proposals.length;i++) {
    const p=proposals[i]!;
    p.changedVariables=S.effectiveChangedFields(e,proposals[0]!.brief,p.brief).map(name=>({name,value:S.changedValue(p.brief,name)}));
  }
  S.validateVariants(e,proposals);
  const before=new Map(e.variants.map(x=>[x.id,x]));
  e.variants=proposals.map(p=>{
    const prior=before.get(p.id)!;
    if(p.id===v.id) return {...p,history:[...prior.history,{revision:prior.revision,brief:prior.brief}],revision:prior.revision+1,
      ...(edit.title===undefined?{}:{title:edit.title}),...(edit.hypothesis===undefined?{}:{hypothesis:edit.hypothesis})};
    if(mirroredTo.has(p.id)) return {...p,history:[...prior.history,{revision:prior.revision,brief:prior.brief}],revision:prior.revision+1};
    return p;
  });
}
/** SLA-806: an approved estimate on a capped test must fit what the test's other attempts left. store.save() enforces the same cap on the actual charges. */
async function assertTestBudget(e: S.Experiment, credits: number) {
  if (!e.testKey || typeof e.testMaxCredits !== 'number' || credits <= 0) return;
  const others = await store.siblingCharged(e);
  if (others + e.creditsCharged + credits > e.testMaxCredits) throw store.testBudgetExceeded(e, others, credits);
}
export async function mutate(workspaceId:string,id:string,action:string,raw:unknown,variantId?:string) {
  // SLA-451: exact_edit is a separately selected operation. Its actions are
  // refused on a legacy experiment and legacy actions are refused on it, so a
  // legacy client can never be migrated into this contract implicitly.
  if (EXACT_EDIT_ACTIONS.has(action) && !isExactEditRequest(raw))
    throw new S.ExperimentError(409,'exact_edit_not_requested','This action is only available to an explicit exact_edit request.');
  const schema = action==='exact-edit' ? S.ExactEditRequest
    : action==='plan' ? S.Plan : action==='generate' ? S.Generate : action==='retry' ? S.Retry : action==='revise' ? S.Revise : action==='edit' ? S.EditBrief
    : action==='feedback' ? S.Feedback : S.Command;
  const b = schema.parse(raw);
  const e = await store.load(workspaceId,id);
  if (EXACT_EDIT_ACTIONS.has(action) && e.operation?.kind !== S.EXACT_EDIT_OPERATION)
    throw new S.ExperimentError(409,'exact_edit_not_requested','This experiment is not an exact_edit operation.');
  if (!EXACT_EDIT_ACTIONS.has(action) && e.operation?.kind === S.EXACT_EDIT_OPERATION)
    throw new S.ExperimentError(409,'exact_edit_action_required','This experiment is an exact_edit operation; only exact-edit actions apply.');
  const key = 'idempotencyKey' in b ? b.idempotencyKey as string : null;
  const hash = fingerprint({action,body:b});
  if (key && e.commands[key]) {
    if (e.commands[key]!==hash) throw new S.ExperimentError(409,'idempotency_conflict');
    return e;
  }
  if (Object.keys(e.commands).length >= 100) throw new S.ExperimentError(409,'command_limit');
  if (action==='exact-edit') {
    // Compile the immutable contract and store it as the ONE hash that the
    // effective brief, the compositor and QA all bind to. No planner call, no
    // ranking, no selector, no variant fan-out and no credits.
    const contract = compileExactEdit(b);
    if (e.exactEdit && e.exactEdit.canonicalSha256 !== contract.canonicalSha256) {
      // Mutating any field after preparation requires a new contract; silently
      // swapping it under an existing one is exactly what the hash prevents.
      throw new S.ExperimentError(409,'exact_edit_contract_changed','The submitted exact_edit contract differs from the prepared one; cancel and re-create rather than mutate it.');
    }
    e.exactEdit = contract;
    e.operation = { kind: S.EXACT_EDIT_OPERATION, contractVersion: contract.contractVersion };
    e.variantCount = contract.variantCount;
    e.slideCount = contract.slides.length;
    e.status = 'review';
    e.error = null;
    e.notices = ['exact_edit: one deck, one variant, no alternatives were generated.'];
  } else if (action==='cancel') {
    e.status='cancelled'; e.error=null;
    for (const v of e.variants) if (v.status==='generating') v.status='cancelled';
  } else if (action==='plan') {
    if (e.status!=='draft') throw new S.ExperimentError(409,'not_draft');
    const est = await estimate(e,'plan');
    await assertTestBudget(e, est.totalCredits);
    applyApprovedEstimate(e, est);
    e.allowPartial=S.Plan.parse(b).allowPartial??false;
    e.status='planning';
    e.tasks=[...e.inputs.filter(i=>i.status!=='ready').map(i=>task('analysis',i.videoId)),...(isContractPipeline(e)?[]:[task('report')]),task('briefs')];
  } else if (action==='edit') {
    applyVariantEdit(e,variantId,S.EditBrief.parse(b));
  } else if(action==='generate') {
    if(e.status!=='review' && e.status!=='completed') throw new S.ExperimentError(409,'not_reviewable');
    const choices=S.Generate.parse(b).variants;
    const vs=selected(e,choices.map(v=>v.id));
    for(const v of vs) if(v.status!=='draft' || choices.find(x=>x.id===v.id)!.revision!==v.revision) throw new S.ExperimentError(409,'revision_conflict');
    S.validateVariants(e,e.variants);
    const est=await estimate(e,'generate',vs.map(x=>x.id));
    await assertTestBudget(e, est.totalCredits);
    // Repair rounds are new paid tasks. Raise the cap to cover them when the wallet can, so a QA retry does not pause the run.
    applyApprovedEstimate(e, isContractPipeline(e) ? {...est,totalCredits:Math.max(est.totalCredits,Math.min(est.maxTotalCredits,est.workspaceCredits))} : est);
    for(const v of vs) {
      v.frozenBrief=structuredClone(v.brief);v.status='generating';
      v.slides=v.brief.slides.map((_s,index)=>({index,status:'pending',url:null,path:null,error:null,overlayText:persistedOverlayText(v.brief,index)}));
      if(isContractPipeline(e))e.tasks.push(...generationTasks(v));
      else e.tasks.push(...v.slides.map(s=>task('slide',v.id,s.index)));
    }
    e.status='generating';
  } else if(action==='retry') {
    retryJobs(e,b);
  } else if(action==='revise') {
    // A QA-failed experiment: the model rewrites the brief against the QA failures, then every arm is rendered and checked again.
    const est=await estimateRevise(e);
    await assertTestBudget(e, est.totalCredits);
    applyApprovedEstimate(e,{...est,totalCredits:Math.max(est.totalCredits,Math.min(est.maxTotalCredits,est.workspaceCredits))});
    applyRevise(e);
  } else if(action==='feedback') {
    // SLA-797: re-render the slideshow (or the named slides) against the user's notes, then QA it again.
    const {workspaceId:_w,idempotencyKey:_k,...req}=S.Feedback.parse(b);
    const est=await estimateFeedback(e,req);
    await assertTestBudget(e, est.totalCredits);
    applyApprovedEstimate(e,{...est,totalCredits:Math.max(est.totalCredits,Math.min(est.maxTotalCredits,est.workspaceCredits))});
    applyFeedback(e,req);
  } else throw new S.ExperimentError(404,'action_not_found');
  if(key)e.commands[key]=hash;
  if(!await store.save(e)) throw new S.ExperimentError(409,'concurrent_update');
  return e;
}
