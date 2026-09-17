import { randomUUID } from 'node:crypto';
import { remainingD1Queries } from '../cf/d1-budget.js';
import { ZodError } from 'zod/v4';
import { InsufficientCreditsError } from '../lib/credits.js';
import * as store from './store.js';
import { prepare, SafeFailure, HydrationPending, type Prepared } from './providers.js';
import { taskCost } from './service.js';
import { ExperimentError, type Experiment, type Task, type Input, type ReportData, type Proposal } from './schema.js';
export interface EngineDeps {
  load: typeof store.load; save: typeof store.save;
  prepare(e:Experiment,t:Task):Promise<Prepared>;
  now():number;
}
const defaults:EngineDeps={load:store.load,save:store.save,prepare,now:Date.now};
const isActive=(e:Experiment)=>e.status==='planning'||e.status==='generating';
function settle(e:Experiment,t:Task,result:unknown) {
  t.status='done';t.error=undefined;
  if(t.kind==='analysis') {
    const input=result as Input; e.inputs[e.inputs.findIndex(i=>i.videoId===t.target)]=input;
  } else if(t.kind==='report') e.report={...result as ReportData,coverage:{included:e.inputs.filter(i=>i.status==='ready').map(i=>i.videoId),excluded:e.inputs.filter(i=>i.status!=='ready').map(i=>({videoId:i.videoId,error:i.error})),partial:e.inputs.some(i=>i.status!=='ready')}};
  else if(t.kind==='briefs') {
    const baselineId=randomUUID();
    e.variants=(result as Proposal[]).map((v,i)=>({...v,id:i===0?baselineId:randomUUID(),baselineId:i===0?null:baselineId,revision:1,status:'draft',generationBasis:'text-directed',history:[],frozenBrief:null,slides:[],error:null}));
    if(isActive(e))e.status='review';
  } else {
    const v=e.variants.find(v=>v.id===t.target)!;const slide=v.slides[t.index!]!;
    Object.assign(slide,result,{status:'done',error:null}); t.path=(result as {path:string}).path;
    if(v.slides.every(s=>s.status==='done'))v.status='done';
    if(isActive(e)&&e.tasks.filter(t=>t.kind==='slide').every(t=>t.status==='done'))e.status=e.variants.some(v=>v.status==='draft')?'review':'completed';
  }
}
/** Advance exactly one paid step, with a durable receipt before provider invocation.
 * CAS losers never call the provider. Unknown receipts are never automatically replayed.
 */
export async function step(workspaceId:string,id:string,deps:EngineDeps=defaults):Promise<boolean> {
  let e=await deps.load(workspaceId,id);if(!isActive(e))return false;
  const running=e.tasks.find(t=>t.status==='running');
  if(running){
    if(deps.now()-(running.startedAt??0)<180000)return false;
    running.status='unknown';running.error='provider_outcome_unknown';e.status='paused';e.error='Provider outcome unknown. Reconciliation required; no automatic retry.';
    await deps.save(e);return false;
  }
  const t=e.tasks.find(t=>t.status==='pending');if(!t)return false;
  let prepared:Prepared;
  try{prepared=await deps.prepare(e,t);}catch(err){
    if(err instanceof HydrationPending){
      const input=e.inputs.find(i=>i.videoId===t.target);if(input&&!input.jobId){input.jobId=err.jobId;input.status='hydrating';input.error=null;}
      await deps.save(e);return false;
    }
    t.status='failed';t.error=err instanceof SafeFailure?err.message:'preparation_failed';
    // workerd hides stack traces from container logs; record the actual cause
    // or every non-SafeFailure reads as the generic preparation_failed.
    if(!(err instanceof SafeFailure))console.error(`[experiments] prepare ${t.kind}${t.index!==undefined?`#${t.index}`:''} for ${e.id} failed`,err);
    const input=e.inputs.find(i=>i.videoId===t.target);if(input){input.status='failed';input.error=t.error;}
    if(t.kind!=='analysis'||!e.allowPartial){e.status='failed';e.error=t.error;}
    await deps.save(e);return e.status==='planning';
  }
  if(prepared.free){t.charged=0;}
  // Re-read after free media preparation: cancellation/edit may have won while reading assets.
  if(t.kind==='report') {
    if(!e.inputs.some(i=>i.status==='ready') || (!e.allowPartial&&e.inputs.some(i=>i.status!=='ready'))){
      e.status='failed';e.error='incomplete_coverage';await deps.save(e);return false;
    }
  }
  // Re-read after free media preparation: cancellation/edit may have won while reading assets.
  e=await deps.load(workspaceId,id);if(!isActive(e))return false;
  const claimed=e.tasks.find(x=>x.id===t.id);if(!claimed||claimed.status!=='pending')return false;
  claimed.status='running';claimed.startedAt=deps.now();claimed.attempts++;
  const charge=prepared.free ? 0 : taskCost(claimed);claimed.charged+=charge;
  claimed.chargeRef = charge ? `experiment:${e.id}:${claimed.id}:${claimed.attempts}` : undefined;
  try{if(!await deps.save(e,charge,claimed.chargeRef))return false;}catch(err){
    if(!(err instanceof InsufficientCreditsError || err instanceof ExperimentError))throw err;
    const latest=await deps.load(workspaceId,id);if(isActive(latest)){latest.status='paused';latest.error=err instanceof ExperimentError ? err.message : 'insufficient_budget';await deps.save(latest);}return false;
  }
  let result:unknown;let failure:unknown;
  try{result=await prepared.execute();}catch(err){failure=err;}
  // Persist result against fresh cancellation/version state; do not erase a concurrent command.
  // CAS retries are DB-only and never repeat provider work.
  for(let attempt=0;attempt<5;attempt++){
    // A refund settlement needs one read, two billing lookups and three
    // batched statements. Leave the durable receipt intact if fenced out.
    if(remainingD1Queries()<6)return false;
    const latest=await deps.load(workspaceId,id);const receipt=latest.tasks.find(x=>x.id===t.id)!;
    if(receipt.status==='done'||receipt.status==='failed')return isActive(latest);
    let refund = 0;
    if(failure){
      const known=failure instanceof SafeFailure || failure instanceof ZodError || failure instanceof ExperimentError;
      receipt.status=known?'failed':'unknown';receipt.error=known?'provider_result_rejected':'provider_outcome_unknown';
      if(known && receipt.chargeRef && charge) { refund = charge; receipt.charged -= refund; }
      const input=latest.inputs.find(i=>i.videoId===t.target);if(t.kind==='analysis'&&input){input.status='failed';input.error=receipt.error;}
      const v=latest.variants.find(v=>v.id===t.target);if(v){v.status=known?'failed':'paused';v.error=receipt.error;if(t.index!==undefined){v.slides[t.index]!.status=receipt.status;v.slides[t.index]!.error=receipt.error;}}
      if(isActive(latest)&&!(known&&t.kind==='analysis'&&latest.allowPartial)) {latest.status=known?'failed':'paused';latest.error=receipt.error;}
    }else settle(latest,receipt,result);
    if(await deps.save(latest,-refund,refund ? receipt.chargeRef : undefined))return isActive(latest);
  }
  // Receipt stays running; lease expiry pauses instead of rebilling a successful but uncommitted output.
  return false;
}
export const STEP_QUERY_RESERVE = 40;
export async function tick(wallBudgetMs=120000, deps = { candidates: store.candidates, step, remaining: remainingD1Queries, now: Date.now }): Promise<{steps:number;active:boolean}> {
  const deadline=deps.now()+Math.min(wallBudgetMs,180000);let steps=0;
  const maxSteps=3;
  // Reserve preparation, claim, provider metadata and all five settlement
  // attempts before paid work. Earlier schedulers consume this same budget.
  if(deps.remaining()<STEP_QUERY_RESERVE+1)return {steps,active:false};
  const candidates=await deps.candidates();
  for(const e of candidates){
    while(deps.now()<deadline && steps<maxSteps && deps.remaining()>=STEP_QUERY_RESERVE){
      const progress=await deps.step(e.workspaceId,e.id);steps++;if(!progress)break;
    }
    if(deps.now()>=deadline||steps>=maxSteps||deps.remaining()<STEP_QUERY_RESERVE)break;
  }
  // Callers keep ticking at a fast cadence while any experiment is still
  // planning/generating, even when this tick made no progress (a running
  // task inside its lease).
  return {steps,active:candidates.length>0};
}
