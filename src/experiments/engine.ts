import { randomUUID } from 'node:crypto';
import { remainingD1Queries } from '../cf/d1-budget.js';
import { ZodError } from 'zod/v4';
import { InsufficientCreditsError } from '../lib/credits.js';
import { classifyOpenRouterError } from '../lib/openrouter.js';
import * as store from './store.js';
import { prepare, SafeFailure, HydrationPending, locksToBaselineVisual, type Prepared } from './providers.js';
import { experimentVisualLock } from './render-prompt.js';
import { taskCost } from './service.js';
import { ExperimentError, MAX_TASK_ATTEMPTS, PARALLEL_SLIDES, retryBackoffMs, type Experiment, type Task, type Input, type ReportData, type Proposal } from './schema.js';
export interface EngineDeps {
  load: typeof store.load; save: typeof store.save;
  prepare(e:Experiment,t:Task):Promise<Prepared>;
  now():number;
}
const defaults:EngineDeps={load:store.load,save:store.save,prepare,now:Date.now};
const isActive=(e:Experiment)=>e.status==='planning'||e.status==='generating';
/** Stable, short cause for the UI/logs. Never include provider payloads. */
function rejectionCause(failure:unknown):string|null {
  if(failure instanceof ExperimentError)return failure.code;
  if(failure instanceof SafeFailure)return failure.message.slice(0,200);
  if(failure instanceof ZodError)return 'invalid_schema';
  if(failure instanceof Error)return providerCause(failure.message);
  return null;
}
function providerCause(message:string):string {
  const classified=classifyOpenRouterError(new Error(message));
  const status=/(\d{3})/.exec(message)?.[1];
  if(classified.category==='quota')return status?`credits_exhausted_${status}`:'credits_exhausted';
  if(classified.category==='rate_limit')return status?`rate_limited_${status}`:'rate_limited';
  if(classified.category==='auth')return status?`auth_${status}`:'auth';
  if(classified.category==='timeout'||/timeout|timed out|abort/i.test(message))return 'timeout';
  if(classified.category==='server')return status?`provider_server_${status}`:'provider_server';
  const gemini=/gemini_(?:outcome_unknown|rejected)_(\d+)/.exec(message);
  if(gemini)return gemini[1]==='429'?'rate_limited_429':`gemini_${gemini[1]}`;
  const stripped=message.replace(/\{[\s\S]*\}/g,'').replace(/\s+/g,' ').trim();
  return stripped.slice(0,80)||'unknown';
}
function shortFailure(failure:unknown):string {
  const m=failure instanceof Error?failure.message:String(failure);
  return m.replace(/\{[\s\S]*\}/g,'').replace(/\s+/g,' ').trim().slice(0,200);
}
function jobError(known:boolean,cause:string|null):string {
  const prefix=known?'provider_result_rejected':'provider_outcome_unknown';
  return cause?`${prefix}:${cause}`:prefix;
}
function settle(e:Experiment,t:Task,result:unknown) {
  t.status='done';t.error=undefined;if(isActive(e))e.error=null;
  if(t.kind==='analysis') {
    const input=result as Input; e.inputs[e.inputs.findIndex(i=>i.videoId===t.target)]=input;
  } else if(t.kind==='report') {
    e.report={...result as ReportData,coverage:{included:e.inputs.filter(i=>i.status==='ready').map(i=>i.videoId),excluded:e.inputs.filter(i=>i.status!=='ready').map(i=>({videoId:i.videoId,error:i.error})),partial:e.inputs.some(i=>i.status!=='ready')}};
    if(isActive(e)&&e.tasks.filter(x=>x.kind==='briefs').every(x=>x.status==='done')&&e.variants.length)e.status='review';
  }
  else if(t.kind==='briefs') {
    // New shape: {proposals, briefJudge}; a plain array is kept for older callers.
    const payload=result as {proposals?:Proposal[];briefJudge?:unknown}|Proposal[];
    const proposals=Array.isArray(payload)?payload:payload.proposals??[];
    const judge=Array.isArray(payload)?undefined:(payload as {briefJudge?:{candidates:Array<{title:string;hook:string;score:number;confidence?:number}>;picked?:string[]}|null}).briefJudge;
    if(judge)e.briefJudge=judge;
    const baselineId=randomUUID();
    const extra=Array.isArray(payload)?undefined:payload as {styleFormula?:Experiment['styleFormula'];slideCount?:number};
    if(extra?.styleFormula)e.styleFormula=extra.styleFormula;
    if(typeof extra?.slideCount==='number')e.slideCount=extra.slideCount;
    e.variants=proposals.map((v,i)=>({...v,id:i===0?baselineId:randomUUID(),baselineId:i===0?null:baselineId,revision:1,status:'draft',generationBasis:e.generationBasis,history:[],frozenBrief:null,slides:[],error:null}));
    // Report (Gemini) and briefs (OpenRouter) may finish in either order.
    if(isActive(e)&&e.tasks.filter(x=>x.kind==='report').every(x=>x.status==='done'))e.status='review';
  } else {
    const v=e.variants.find(v=>v.id===t.target)!;const slide=v.slides[t.index!]!;
    Object.assign(slide,result,{status:'done',error:null}); t.path=(result as {path:string}).path;
    if(v.slides.every(s=>s.status==='done'))v.status='done';
    if(isActive(e)&&e.tasks.filter(t=>t.kind==='slide').every(t=>t.status==='done'))e.status=e.variants.some(v=>v.status==='draft')?'review':'completed';
  }
}
/** Advance paid steps with a durable receipt before each provider invocation.
 * CAS losers never call the provider. Failures and unknown outcomes self-heal through
 * MAX_TASK_ATTEMPTS-1 automatic retries (1 minute apart) before surfacing.
 * Up to PARALLEL_SLIDES renders may run concurrently per experiment: a step whose
 * claim race is lost re-picks another pending task instead of giving up.
 */
export async function step(workspaceId:string,id:string,deps:EngineDeps=defaults):Promise<boolean> {
  let e=await deps.load(workspaceId,id);if(!isActive(e))return false;
  const running=e.tasks.filter(t=>t.status==='running');
  // Briefs with a 20-candidate generation legitimately run for minutes.
  const leaseMs=(t:Task)=>t.kind==='briefs'?600_000:180_000;
  const expired=running.find(t=>deps.now()-(t.startedAt??0)>=leaseMs(t));
  if(expired){
    // The provider request is gone (or settlement stalled). Requeue with backoff while
    // attempts remain — the prior attempt's charge stays retained, so a duplicate
    // delivery costs at most its per-job price. Exhausted receipts pause for review.
    if(expired.attempts<MAX_TASK_ATTEMPTS){expired.status='pending';expired.error='provider_outcome_unknown';expired.nextAttemptAt=deps.now()+retryBackoffMs(expired.attempts);await deps.save(e);return false;}
    expired.status='unknown';expired.error='provider_outcome_unknown';e.status='paused';e.error='Provider outcome unknown. Retry individual jobs from the experiment page.';
    await deps.save(e);return false;
  }
  if(running.length>=PARALLEL_SLIDES)return false;
  for(let pick=0;pick<PARALLEL_SLIDES;pick++){
    if(pick>0){e=await deps.load(workspaceId,id);if(!isActive(e))return false;}
    // Phase gating: analysis first; report (Gemini) and briefs (OpenRouter)
    // overlap; slides wait for briefs.
    const pendingOrRunning=(kind:Task['kind'])=>e.tasks.some(t=>t.kind===kind&&(t.status==='pending'||t.status==='running'));
    const phaseDone=(kind:Task['kind'])=>{const ks=e.tasks.filter(t=>t.kind===kind);return ks.length>0&&ks.every(t=>t.status==='done');};
    // Report (Gemini) and briefs (OpenRouter) are independent after analysis.
    const eligible=(t:Task)=>{
      if(t.kind==='report'||t.kind==='briefs')return !pendingOrRunning('analysis');
      if(t.kind!=='slide')return true;
      if(!phaseDone('briefs'))return false;
      const v=e.variants.find(x=>x.id===t.target);
      const expLock=experimentVisualLock(e.instructions.variables);
      if(v&&(t.index??0)>0&&expLock.subjectLocked){
        const plate=v.slides[0];
        if(plate&&plate.status!=='failed'&&plate.status!=='unknown'&&!(plate.status==='done'&&plate.url))return false;
      }
      if(!v?.baselineId||!locksToBaselineVisual(v.changedVariables??[],e.instructions.variables))return true;
      const base=e.variants.find(x=>x.id===v.baselineId);
      const bs=base?.slides[t.index!];
      if(!bs)return true;
      if(bs.status==='failed'||bs.status==='unknown')return true;
      return bs.status==='done'&&!!bs.url;
    };
    const pending=e.tasks.filter(t=>t.status==='pending'&&(t.nextAttemptAt??0)<=deps.now()&&eligible(t));
    pending.sort((a,b)=>{
      const av=a.kind==='slide'?e.variants.find(v=>v.id===a.target):undefined;
      const bv=b.kind==='slide'?e.variants.find(v=>v.id===b.target):undefined;
      const aBase=av&&!av.baselineId?0:1;
      const bBase=bv&&!bv.baselineId?0:1;
      if(aBase!==bBase)return aBase-bBase;
      return (a.index??0)-(b.index??0);
    });
    const t=pending[0];if(!t)return false;
    let prepared:Prepared;
    try{prepared=await deps.prepare(e,t);}catch(err){
      if(err instanceof HydrationPending){
        const input=e.inputs.find(i=>i.videoId===t.target);if(input&&!input.jobId){input.jobId=err.jobId;input.status='hydrating';input.error=null;}
        await deps.save(e);return false;
      }
      t.attempts++;
      if(t.attempts<MAX_TASK_ATTEMPTS){
        t.status='pending';t.error=err instanceof SafeFailure?err.message:'preparation_failed';t.nextAttemptAt=deps.now()+retryBackoffMs(t.attempts);
        const input=e.inputs.find(i=>i.videoId===t.target);if(input){input.status='pending';input.error=t.error;}
        await deps.save(e);return e.status==='planning';
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
    // Re-read before claiming: a concurrent step may have claimed this exact task.
    e=await deps.load(workspaceId,id);if(!isActive(e))return false;
    const claimed=e.tasks.find(x=>x.id===t.id);
    if(!claimed||claimed.status!=='pending')continue;
    claimed.status='running';claimed.startedAt=deps.now();claimed.attempts++;
    // A fanned-out task pays for every candidate it renders (units × unit price).
    const charge=prepared.free ? 0 : taskCost(claimed)*(prepared.units??1);claimed.charged+=charge;
    claimed.chargeRef = charge ? `experiment:${e.id}:${claimed.id}:${claimed.attempts}` : undefined;
    try{
      if(!await deps.save(e,charge,claimed.chargeRef))continue;
    }catch(err){
      if(!(err instanceof InsufficientCreditsError || err instanceof ExperimentError))throw err;
      const latest=await deps.load(workspaceId,id);if(isActive(latest)){latest.status='paused';latest.error=err instanceof ExperimentError ? err.message : 'insufficient_budget';await deps.save(latest);}return false;
    }
    let result:unknown;let failure:unknown;
    try{result=await prepared.execute();}catch(err){failure=err;}
    if(failure){
      const cause=rejectionCause(failure);
      const known=failure instanceof SafeFailure || failure instanceof ZodError || failure instanceof ExperimentError || /^(credits_exhausted|auth)/.test(cause??'');
      // Codes + short provider status only — briefs payloads and source evidence must not land in logs.
      console.error(`[experiments] ${t.kind}${t.index!==undefined?`#${t.index}`:''} ${e.id} ${jobError(known,cause)} ${shortFailure(failure)}`);
    }
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
        const cause=rejectionCause(failure);
        const terminalQuota=/^(credits_exhausted|auth)/.test(cause??'');
        const known=failure instanceof SafeFailure || failure instanceof ZodError || failure instanceof ExperimentError || terminalQuota;
        receipt.error=jobError(known,cause);
        if(isActive(latest))latest.error=receipt.error;
        if(known && receipt.chargeRef && charge) { refund = charge; receipt.charged -= refund; }
        const input=latest.inputs.find(i=>i.videoId===t.target);
        const v=latest.variants.find(v=>v.id===t.target);
        if(receipt.attempts<MAX_TASK_ATTEMPTS && !terminalQuota){
          // Self-heal: requeue with backoff, keep the experiment running. Known failures
          // are refunded above; unknown receipts keep their retained charge.
          receipt.status='pending';receipt.nextAttemptAt=deps.now()+retryBackoffMs(receipt.attempts);
          if(t.kind==='analysis'&&input){input.status='pending';}
          if(v){v.status='generating';v.error=receipt.error;if(t.index!==undefined){v.slides[t.index]!.status='pending';v.slides[t.index]!.error=receipt.error;}}
        }else{
          receipt.status=known?'failed':'unknown';
          if(t.kind==='analysis'&&input){input.status='failed';input.error=receipt.error;}
          if(v){v.status=known?'failed':'paused';v.error=receipt.error;if(t.index!==undefined){v.slides[t.index]!.status=receipt.status;v.slides[t.index]!.error=receipt.error;}}
          if(isActive(latest)&&!(known&&t.kind==='analysis'&&latest.allowPartial)) {latest.status=known?'failed':'paused';latest.error=receipt.error;}
        }
      }else settle(latest,receipt,result);
      if(await deps.save(latest,-refund,refund ? receipt.chargeRef : undefined))return isActive(latest);
    }
    // Receipt stays running; lease expiry pauses instead of rebilling a successful but uncommitted output.
    return false;
  }
  return false;
}
export const STEP_QUERY_RESERVE = 40;
/**Queries one concurrent step may spend beyond the first reserved step (load/claim/settle). */
const STEP_QUERY_COST = 12;
export async function tick(wallBudgetMs=120000, deps = { candidates: store.candidates, step, remaining: remainingD1Queries, now: Date.now }): Promise<{steps:number;active:boolean}> {
  const deadline=deps.now()+Math.min(wallBudgetMs,180000);let steps=0;
  const maxSteps=3;
  // Reserve preparation, claim, provider metadata and all five settlement
  // attempts before paid work. Earlier schedulers consume this same budget.
  if(deps.remaining()<STEP_QUERY_RESERVE+1)return {steps,active:false};
  const candidates=await deps.candidates();
  for(const e of candidates){
    while(deps.now()<deadline && steps<maxSteps && deps.remaining()>=STEP_QUERY_RESERVE){
      // Launch a wave of concurrent steps: parallel slide renders fill the
      // per-experiment slots (PARALLEL_SLIDES). Wave size shrinks to what the
      // D1 budget can still settle safely.
      const headroom=deps.remaining()-STEP_QUERY_RESERVE;
      const wave=Math.max(1,Math.min(maxSteps-steps,PARALLEL_SLIDES,1+Math.floor(headroom/STEP_QUERY_COST)));
      const results=await Promise.all(Array.from({length:wave},()=>deps.step(e.workspaceId,e.id)));
      steps+=wave;
      if(!results.some(Boolean))break;
    }
    if(deps.now()>=deadline||steps>=maxSteps||deps.remaining()<STEP_QUERY_RESERVE)break;
  }
  // Callers keep ticking at a fast cadence while any experiment is still
  // planning/generating, even when this tick made no progress (a running
  // task inside its lease).
  return {steps,active:candidates.length>0};
}
