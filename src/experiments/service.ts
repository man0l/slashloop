import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { CREDIT_COSTS, creditBalance } from '../lib/credits.js';
import * as S from './schema.js';
import * as store from './store.js';
import { compatibleInput } from './providers.js';
import { isPhotoPost, resolveSlideshowUrls } from '../lib/media.js';
import { effectiveOverlayText } from './render-prompt.js';
import { deriveStorySlideCount } from './slide-count.js';
import { applyApprovedEstimate } from './budget.js';

export const fingerprint = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function createExperiment(raw: unknown) {
  const b = S.Create.parse(raw);
  const now = new Date().toISOString();
  const inputs: S.Input[] = [];
  let referenced = false;
  const slideSources: Array<{ originalCount: number | null; analysis?: unknown }> = [];
  for (const videoId of b.videoIds) {
    const v = await db.video.findFirst({ where: { id: videoId, source: { workspaceId: b.workspaceId } } });
    if (!v) throw new S.ExperimentError(404,'video_not_found');
    // Slideshows only: video posts are disabled for selection — the analysis
    // and render pipeline is carousel-based (slideshow+caption evidence).
    if (!isPhotoPost(v)) throw new S.ExperimentError(400,'video_not_slideshow','Only slideshows can be selected for experiments.');
    referenced = true;
    const originalCount = isPhotoPost(v) ? resolveSlideshowUrls(v.rawJson).length : null;
    let analysis: unknown;
    if (originalCount) {
      const row = await db.analysis.findFirst({ where: { videoId: v.id, schemaVersion: 'v3' }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } });
      if (row?.analysisJson) try { analysis = JSON.parse(row.analysisJson); } catch { /* ignore broken analysis JSON */ }
    }
    slideSources.push({ originalCount: originalCount || null, analysis });
    inputs.push(await compatibleInput(v));
  }
  const { idempotencyKey, videoIds, workspaceId, slideCount: requestedSlideCount, ...fields } = b;
  const slideCount = deriveStorySlideCount(slideSources) ?? requestedSlideCount;
  return store.create({ id: randomUUID(),workspaceId,...fields,slideCount,status:'draft',createdAt:now,updatedAt:now,
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
    return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
      remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
      maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
      maxProviderRequests:jobs.reduce((n,t)=>n+(t.kind==='slide'?S.SLIDE_FANOUT:1),0),
      pricing:{analysis:CREDIT_COSTS.analyzeVideo,planningCall:CREDIT_COSTS.experimentPlanningCall,slide:CREDIT_COSTS.experimentSlide} };
  }
  const analysisCredits = stage === 'plan' ? e.inputs.filter(x=>x.status!=='ready').length*CREDIT_COSTS.analyzeVideo : 0;
  const planningCredits = stage === 'plan' ? (e.report ? 0 : CREDIT_COSTS.experimentPlanningCall) + (e.variants.length ? 0 : CREDIT_COSTS.experimentPlanningCall) : 0;
  const generationCredits = stage === 'generate' ? variants.reduce((n,v)=>n+(v.slides.length ? v.slides.filter(s=>s.status!=='done').length : e.slideCount)*CREDIT_COSTS.experimentSlide,0)*S.SLIDE_FANOUT : 0;
  return { analysisCredits,planningCredits,generationCredits,totalCredits:analysisCredits+planningCredits+generationCredits,
    remainingCredits:e.maxCredits-e.creditsCharged, workspaceCredits:(await creditBalance(e.workspaceId)).total,
    maxCredits:e.maxCredits,generationBasis:e.generationBasis,exactProviderUsdCap:false,
    maxProviderRequests: (stage==='plan' ? analysisCredits/CREDIT_COSTS.analyzeVideo+planningCredits/CREDIT_COSTS.experimentPlanningCall : generationCredits/CREDIT_COSTS.experimentSlide),
    pricing:{analysis:CREDIT_COSTS.analyzeVideo,planningCall:CREDIT_COSTS.experimentPlanningCall,slide:CREDIT_COSTS.experimentSlide} };
}
const task = (kind:S.Task['kind'], target?:string,index?:number):S.Task => ({id:randomUUID(),kind,target,index,status:'pending',attempts:0,charged:0});
export async function mutate(workspaceId:string,id:string,action:string,raw:unknown,variantId?:string) {
  const schema = action==='plan' ? S.Plan : action==='generate' ? S.Generate : action==='retry' ? S.Retry : action==='edit' ? S.EditBrief : S.Command;
  const b = schema.parse(raw);
  const e = await store.load(workspaceId,id);
  const key = 'idempotencyKey' in b ? b.idempotencyKey as string : null;
  const hash = fingerprint({action,body:b});
  if (key && e.commands[key]) {
    if (e.commands[key]!==hash) throw new S.ExperimentError(409,'idempotency_conflict');
    return e;
  }
  if (Object.keys(e.commands).length >= 100) throw new S.ExperimentError(409,'command_limit');
  if (action==='cancel') {
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
      v.slides=v.brief.slides.map((_s,index)=>({index,status:'pending',url:null,path:null,error:null,overlayText:effectiveOverlayText(v.brief,index)}));
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
    for(const t of retryTasks) {t.status='pending';t.error=undefined;t.nextAttemptAt=undefined;}
    for(const v of e.variants){
      const vt=retryTasks.filter(t=>t.target===v.id);
      if(!vt.length) continue;
      v.status='generating';v.error=null;
      for(const t of vt) if(t.index!==undefined){v.slides[t.index]!.status='pending';}
    }
    e.error=null;e.status=e.report&&e.variants.length?'generating':'planning';
  } else throw new S.ExperimentError(404,'action_not_found');
  if(key)e.commands[key]=hash;
  if(!await store.save(e)) throw new S.ExperimentError(409,'concurrent_update');
  return e;
}
