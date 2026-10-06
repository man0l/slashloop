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
import { compileExactEdit } from './exact-edit.js';

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
export async function createExactEdit(raw: unknown) {
  const b = S.ExactEditRequest.parse(raw);
  const now = new Date().toISOString();
  const contract = compileExactEdit(b);
  const v = await db.video.findFirst({ where: { id: b.source.videoId, source: { workspaceId: b.workspaceId } } });
  if (!v) throw new S.ExperimentError(404,'video_not_found');
  if (!isPhotoPost(v) && !hasExperimentSlides(v.rawJson)) throw new S.ExperimentError(400,'video_not_slideshow','Only slideshows can be edited.');
  return store.create({
    id: randomUUID(), workspaceId: b.workspaceId, status: 'review', createdAt: now, updatedAt: now,
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
  persist: (experiment: S.Experiment, idempotencyKey: string) => Promise<S.Experiment>;
};
export const createDeps: CreateExperimentDeps = {
  findSource: (workspaceId, videoId) => db.video.findFirst({ where: { id: videoId, source: { workspaceId } } }),
  findLatestAnalysis: (videoId) => db.analysis.findFirst({ where: { videoId, schemaVersion: 'v3' }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } }),
  buildInput: compatibleInput,
  persist: store.create,
};
export async function createExperiment(raw: unknown, deps: CreateExperimentDeps = createDeps) {
  // Legacy create: the two-variant planner path, unchanged. An exact_edit body
  // has its own entry point and must not be coerced through this schema.
  if (isExactEditRequest(raw)) throw new S.ExperimentError(409,'exact_edit_requires_exact_edit_action','Create an exact_edit deck with create_exact_edit; it does not use the legacy planner.');
  const b = S.Create.parse(raw);
  const now = new Date().toISOString();
  const inputs: S.Input[] = [];
  let referenced = false;
  const slideSources: Array<{ originalCount: number | null; analysis?: unknown }> = [];
  const tags: string[] = [];
  for (const videoId of b.videoIds) {
    const v = await deps.findSource(b.workspaceId, videoId);
    if (!v) throw new S.ExperimentError(404,'video_not_found');
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
    slideSources.push({ originalCount: originalCount || null, analysis });
    inputs.push(await deps.buildInput(v));
  }
  const { idempotencyKey, videoIds, workspaceId, slideCount: requestedSlideCount, ...fields } = b;
  // Persisted count: SLA-476 — the source deck keeps its own closing CTA slide
  // only when the caller opted in. Both boundaries read the same flag off the
  // stored instructions, so planning cannot undo what creation persisted.
  const slideCount = deriveStorySlideCount(slideSources, fields.instructions.preserveSourceCtaSlide) ?? requestedSlideCount;
  // Each experiment is isolated per slideshow but the goal doubles as the list
  // title — identical goals are indistinguishable. Suffix a quick source
  // summary unless the caller already named the source (e.g. re-duplicates).
  if (tags.length) {
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
  return deps.persist({ id: randomUUID(),workspaceId,...fields,slideCount,status:'draft',createdAt:now,updatedAt:now,
    creditsCharged:0,report:null,inputs,variants:[],error:null,
    // Slideshow sources are attached as visual references during rendering; video-only stays text-directed.
    generationBasis:referenced?'source-referenced':'text-directed',
    assetPolicy:'Generated outputs retained until explicit deletion; never swept with source media. No Stream copies. Gemini uploads named experiment-temp expire at provider in approximately 48h; reusable handles expire locally at 40h.',
    version:0,tasks:[],commands:{},allowPartial:false,createFingerprint:fingerprint(b) },idempotencyKey);
}
function selected(e: S.Experiment, ids?: string[]) {
  if (ids && new Set(ids).size !== ids.length) throw new S.ExperimentError(400,'duplicate_variant');
  const variants = ids ? ids.map(id => { const v = e.variants.find(v => v.id===id); if (!v) throw new S.ExperimentError(404,'variant_not_found'); return v; }) : e.variants;
  return variants;
}
export function taskCost(t: Pick<S.Task,'kind'>) { return t.kind==='analysis' ? CREDIT_COSTS.analyzeVideo : t.kind==='slide' ? CREDIT_COSTS.experimentSlide : CREDIT_COSTS.experimentPlanningCall; }
export async function estimate(e: S.Experiment, stage: 'plan'|'generate', ids?: string[], taskIds?: string[]) {
  if (stage === 'plan' && ids) throw new S.ExperimentError(400,'variantIds_only_for_generation');
  const variants = selected(e,ids);
  if (taskIds) {
    // Per-job retry estimate: price exactly the named jobs that still need provider work.
    const wanted = new Set(taskIds);
    const jobs = e.tasks.filter(t=>wanted.has(t.id)&&t.status!=='done');
    const priceOf = (t:S.Task)=>t.kind==='slide' ? CREDIT_COSTS.experimentSlide*S.SLIDE_FANOUT : taskCost(t);
    const analysisCredits = jobs.filter(t=>t.kind==='analysis').reduce((n,t)=>n+priceOf(t),0);
    const planningCredits = jobs.filter(t=>t.kind==='report'||t.kind==='briefs').reduce((n,t)=>n+priceOf(t),0);
    const generationCredits = jobs.filter(t=>t.kind==='slide').reduce((n,t)=>n+priceOf(t),0);
    const correctionCredits = jobs.filter(t=>t.kind==='slide').length*CREDIT_COSTS.experimentSlide*S.SLIDE_FANOUT*(S.qaMaxAttempts()-1);
    return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
      correctionCredits,maxTotalCredits:analysisCredits+planningCredits+generationCredits+correctionCredits,
      remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
      maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
      maxProviderRequests:jobs.reduce((n,t)=>n+(t.kind==='slide'?S.slideTaskRequestCap():1),0),
      pricing:{analysis:CREDIT_COSTS.analyzeVideo,planningCall:CREDIT_COSTS.experimentPlanningCall,slide:CREDIT_COSTS.experimentSlide} };
  }
  const analysisCredits = stage === 'plan' ? e.inputs.filter(x=>x.status!=='ready').length*CREDIT_COSTS.analyzeVideo : 0;
  const planningCredits = stage === 'plan' ? (e.report ? 0 : CREDIT_COSTS.experimentPlanningCall) + (e.variants.length ? 0 : CREDIT_COSTS.experimentPlanningCall) : 0;
  const generationCredits = stage === 'generate' ? variants.reduce((n,v)=>n+(v.slides.length ? v.slides.filter(s=>s.status!=='done').length : e.slideCount)*CREDIT_COSTS.experimentSlide,0)*S.SLIDE_FANOUT : 0;
  // Every slide can buy up to qaMaxAttempts-1 more full fan-out waves; each is admitted against the
  // remaining experiment credit and the wallet before its provider calls, so this is a ceiling on
  // requests, never an amount charged up front.
  const correctionCredits = generationCredits*(S.qaMaxAttempts()-1);
  return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
    correctionCredits,maxTotalCredits:analysisCredits+planningCredits+generationCredits+correctionCredits,
    remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
    maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
    maxProviderRequests: (stage==='plan' ? analysisCredits/CREDIT_COSTS.analyzeVideo+planningCredits/CREDIT_COSTS.experimentPlanningCall : generationCredits/CREDIT_COSTS.experimentSlide/S.SLIDE_FANOUT*S.slideTaskRequestCap()),
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
    t.status='pending';t.error=undefined;t.nextAttemptAt=undefined;
  }
  for(const v of e.variants){
    const vt=retryTasks.filter(t=>t.target===v.id);
    if(!vt.length) continue;
    v.status='generating';v.error=null;
    for(const t of vt) if(t.index!==undefined){
      const slide=v.slides[t.index];if(!slide) continue;
      slide.status='pending';
      slide.error=null;
      if(slide.qa){
        const {prompt:_prompt,...record}=slide.qa;
        slide.qaHistory=[...(slide.qaHistory??[]),record].slice(-S.QA_HISTORY_LIMIT);
        slide.qa=null;
      }
    }
  }
}
export async function mutate(workspaceId:string,id:string,action:string,raw:unknown,variantId?:string) {
  // SLA-451: exact_edit is a separately selected operation. Its actions are
  // refused on a legacy experiment and legacy actions are refused on it, so a
  // legacy client can never be migrated into this contract implicitly.
  if (EXACT_EDIT_ACTIONS.has(action) && !isExactEditRequest(raw))
    throw new S.ExperimentError(409,'exact_edit_not_requested','This action is only available to an explicit exact_edit request.');
  const schema = action==='exact-edit' ? S.ExactEditRequest
    : action==='plan' ? S.Plan : action==='generate' ? S.Generate : action==='retry' ? S.Retry : action==='edit' ? S.EditBrief : S.Command;
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
    applyApprovedEstimate(e, est);
    e.allowPartial=S.Plan.parse(b).allowPartial??false;
    e.status='planning';
    e.tasks=[...e.inputs.filter(i=>i.status!=='ready').map(i=>task('analysis',i.videoId)),task('report'),task('briefs')];
  } else if (action==='edit') {
    if (e.status!=='review' || !variantId) throw new S.ExperimentError(409,'not_idle');
    const v=selected(e,[variantId])[0]!; const edit=S.EditBrief.parse(b);
    if(v.status!=='draft' || v.revision!==edit.revision || v.frozenBrief) throw new S.ExperimentError(409,'revision_conflict');
    S.assertBrief(e,edit.brief);
    const proposals=e.variants.map(p=>p.id===v.id?{...p,brief:edit.brief}:p);
    // Derive factual delta labels rather than accepting stale model labels after editing.
    for(let i=1;i<proposals.length;i++) {
      const p=proposals[i]!;
      p.changedVariables=S.VARIABLE_FIELDS.filter(k=>!S.same(p.brief[k],proposals[0]!.brief[k])).map(name=>({name,value:typeof p.brief[name]==='string'?p.brief[name] as string:JSON.stringify(p.brief[name])}));
    }
    S.validateVariants(e,proposals);
    e.variants=proposals; const changed=e.variants.find(x=>x.id===v.id)!;
    changed.history.push({revision:changed.revision,brief:v.brief}); changed.brief=edit.brief; changed.revision++;
  } else if(action==='generate') {
    if(e.status!=='review' && e.status!=='completed') throw new S.ExperimentError(409,'not_reviewable');
    const choices=S.Generate.parse(b).variants;
    const vs=selected(e,choices.map(v=>v.id));
    for(const v of vs) if(v.status!=='draft' || choices.find(x=>x.id===v.id)!.revision!==v.revision) throw new S.ExperimentError(409,'revision_conflict');
    S.validateVariants(e,e.variants);
    const est=await estimate(e,'generate',vs.map(x=>x.id));
    applyApprovedEstimate(e, est);
    for(const v of vs) {
      v.frozenBrief=structuredClone(v.brief);v.status='generating';
      v.slides=v.brief.slides.map((_s,index)=>({index,status:'pending',url:null,path:null,error:null,overlayText:persistedOverlayText(v.brief,index)}));
      e.tasks.push(...v.slides.map(s=>task('slide',v.id,s.index)));
    }
    e.status='generating';
  } else if(action==='retry') {
    if(e.status!=='failed' && e.status!=='paused') throw new S.ExperimentError(409,'not_retryable');
    // Only genuinely in-flight leases block a retry; exhausted/unknown jobs are retryable
    // on demand (each retry re-charges, so a lost provider delivery costs at most one more).
    if(e.tasks.some(t=>t.status==='running')) throw new S.ExperimentError(409,'provider_outcome_unknown','A provider request is still in flight. Refresh and retry in a moment.');
    const ids=S.Retry.parse(b).variantIds; const wantedTaskIds=S.Retry.parse(b).taskIds;
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
    e.error=null;e.status=e.report&&e.variants.length?'generating':'planning';
  } else throw new S.ExperimentError(404,'action_not_found');
  if(key)e.commands[key]=hash;
  if(!await store.save(e)) throw new S.ExperimentError(409,'concurrent_update');
  return e;
}
