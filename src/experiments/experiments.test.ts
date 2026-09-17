import { describe, test, expect } from 'bun:test';
import { step, type EngineDeps } from './engine.js';
import { Create, Retry, validateVariants, validateReport, type Experiment, type BriefData } from './schema.js';
import { HydrationPending, SafeFailure } from './providers.js';
const instructions={goal:'Sell tea',brand:'Tea',audience:'Adults',language:'English',direction:'Calm',lockedConstraints:['No health claims'],variables:['hook' as const],mode:'controlled' as const};
export const brief:BriefData={concept:'Tea routine',hook:'Take a break',character:'Adult',visualStyle:'Warm',caption:'Tea time',cta:'Try tea',lockedConstraints:['No health claims'],slides:Array.from({length:3},(_,i)=>({role:i?'body':'hook',scene:'Tea cup',overlayText:''}))};
function fixture():Experiment{return {id:'e',workspaceId:'w',status:'planning',version:0,createdAt:'',updatedAt:'',instructions,variantCount:2,slideCount:3,maxCredits:100,creditsCharged:0,report:null,inputs:[{videoId:'v',status:'pending',analysisId:null,jobId:null,error:null,coverage:null,evidence:[]}],variants:[],error:null,generationBasis:'text-directed',assetPolicy:'retained',tasks:[{id:'t',kind:'analysis',target:'v',status:'pending',attempts:0,charged:0}],commands:{},allowPartial:false,createFingerprint:'x'};}
function harness(prepare:EngineDeps['prepare']){let row=fixture();let charges=0;const deps:EngineDeps={load:async()=>structuredClone(row),save:async(e,charge=0)=>{if(e.version!==row.version)return false;row=structuredClone({...e,version:e.version+1,creditsCharged:e.creditsCharged+charge});charges+=charge;Object.assign(e,row);return true;},prepare,now:()=>1000};return {deps,get row(){return row;},get charges(){return charges;},set(e:Experiment){row=e;}};}
const result={videoId:'v',status:'ready',analysisId:'a',jobId:null,error:null,coverage:{basis:'video',observed:1,total:null,complete:true},evidence:[{location:'second:0',observation:'A cup'}]};
describe('durable experiment steps',()=>{
 test('concurrent ticks submit and debit once',async()=>{let calls=0;const h=harness(async()=>({execute:async()=>{calls++;return result;}}));await Promise.all([step('w','e',h.deps),step('w','e',h.deps)]);expect(calls).toBe(1);expect(h.charges).toBe(5);expect(h.row.inputs[0]?.analysisId).toBe('a');});
 test('parallel steps fill slots with distinct jobs, never double-charging',async()=>{let calls=0;const h=harness(async(_e,t)=>({execute:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {...result,videoId:t.target!};}}));
  const inputs=['v1','v2','v3'].map(videoId=>({videoId,status:'pending',analysisId:null,jobId:null,error:null,coverage:null,evidence:[]}));
  const tasks=['t1','t2','t3'].map((id,i)=>({id,kind:'analysis' as const,target:`v${i+1}`,status:'pending' as const,attempts:0,charged:0}));
  h.set({...fixture(),inputs,tasks});
  await Promise.all([step('w','e',h.deps),step('w','e',h.deps),step('w','e',h.deps),step('w','e',h.deps)]);
  expect(calls).toBe(3);expect(h.charges).toBe(15);
  expect(h.row.inputs.map(i=>i.status)).toEqual(['ready','ready','ready']);});
 test('briefs never runs while the report is still running',async()=>{let calls=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const h=harness(async()=>({execute:async()=>{calls++;await gate;return {};}}));
  h.set({...fixture(),inputs:[{videoId:'v',status:'ready',analysisId:'a',jobId:null,error:null,coverage:{basis:'video',observed:1,total:null,complete:true},evidence:[{location:'second:0',observation:'A cup'}]}],tasks:[
    {id:'r',kind:'report',status:'pending',attempts:0,charged:0},
    {id:'b',kind:'briefs',status:'pending',attempts:0,charged:0},
  ]});
  const a=step('w','e',h.deps);
  await new Promise(r=>setTimeout(r,10));
  const b=await step('w','e',h.deps);
  expect(b).toBe(false);expect(calls).toBe(1);
  expect(h.row.tasks.find(t=>t.kind==='briefs')?.status).toBe('pending');
  release();await a;expect(calls).toBe(1);});
 test('compatible analysis discovered after queueing is free',async()=>{const h=harness(async()=>({free:true,execute:async()=>result}));await step('w','e',h.deps);expect(h.charges).toBe(0);expect(h.row.inputs[0]?.status).toBe('ready');});
 test('hydration parks existing MediaJob id without charging',async()=>{const h=harness(async()=>{throw new HydrationPending('fetch-1');});expect(await step('w','e',h.deps)).toBe(false);expect(h.row.inputs[0]).toMatchObject({status:'hydrating',jobId:'fetch-1'});expect(h.charges).toBe(0);expect(h.row.tasks[0]?.status).toBe('pending');});
 test('unknown paid outcome pauses and never submits again',async()=>{let calls=0;const h=harness(async()=>({execute:async()=>{calls++;throw new Error('socket lost');}}));h.set({...fixture(),tasks:[{id:'t',kind:'analysis',target:'v',status:'pending',attempts:3,charged:0}]});await step('w','e',h.deps);expect(h.row.status).toBe('paused');expect(h.row.tasks[0]?.status).toBe('unknown');expect(h.charges).toBe(5);expect(calls).toBe(1);});
 test('expired running receipt pauses, not reclaimed',async()=>{const h=harness(async()=>{throw new Error('must not prepare');});h.set({...fixture(),tasks:[{id:'t',kind:'analysis',status:'running',attempts:4,charged:5,startedAt:1}]});h.deps.now=()=>999999;await step('w','e',h.deps);expect(h.row.status).toBe('paused');expect(h.charges).toBe(0);});
 test('expired lease requeues with backoff while attempts remain',async()=>{const h=harness(async()=>{throw new Error('must not prepare');});h.set({...fixture(),tasks:[{id:'t',kind:'analysis',status:'running',attempts:1,charged:5,startedAt:1}]});h.deps.now=()=>999999;await step('w','e',h.deps);expect(h.row.status).toBe('planning');expect(h.row.tasks[0]).toMatchObject({status:'pending',nextAttemptAt:999999+60_000});expect(h.charges).toBe(0);});
 test('cancel during preparation prevents new paid work',async()=>{let called=false;const h=harness(async()=>{h.set({...h.row,status:'cancelled',version:1});return {execute:async()=>{called=true;}};});await step('w','e',h.deps);expect(called).toBe(false);expect(h.charges).toBe(0);});
 test('cancel during provider preserves successful output but stays cancelled',async()=>{const h=harness(async()=>({execute:async()=>{h.set({...h.row,status:'cancelled',version:h.row.version+1});return result;}}));await step('w','e',h.deps);expect(h.row.status).toBe('cancelled');expect(h.row.inputs[0]?.status).toBe('ready');});
 test('known rejected output fails without silently rerunning',async()=>{const h=harness(async()=>({execute:async()=>{throw new SafeFailure('invalid_json');}}));h.set({...fixture(),tasks:[{id:'t',kind:'analysis',target:'v',status:'pending',attempts:3,charged:0}]});await step('w','e',h.deps);expect(h.row.status).toBe('failed');expect(h.row.tasks[0]?.error).toBe('provider_result_rejected');expect(h.charges).toBe(0);expect(h.row.tasks[0]?.charged).toBe(0);});
 test('known rejection auto-retries three times with backoff before failing',async()=>{let calls=0;let clock=1000;const h=harness(async()=>({execute:async()=>{calls++;throw new SafeFailure('invalid_image_size');}}));h.deps.now=()=>clock;
  await step('w','e',h.deps);
  expect(calls).toBe(1);expect(h.row.status).toBe('planning');expect(h.charges).toBe(0);
  expect(h.row.tasks[0]).toMatchObject({status:'pending',nextAttemptAt:1000+60_000,error:'provider_result_rejected'});
  clock+=60_000;await step('w','e',h.deps);
  expect(calls).toBe(2);expect(h.row.tasks[0]?.nextAttemptAt).toBe(clock+300_000);
  clock+=300_000;await step('w','e',h.deps);
  expect(calls).toBe(3);expect(h.row.tasks[0]?.nextAttemptAt).toBe(clock+900_000);
  clock+=900_000;await step('w','e',h.deps);
  expect(calls).toBe(4);expect(h.row.status).toBe('failed');expect(h.row.tasks[0]?.status).toBe('failed');});
 test('unknown outcome auto-retries with retained charge, then pauses',async()=>{let calls=0;let clock=1000;const h=harness(async()=>({execute:async()=>{calls++;throw new Error('socket lost');}}));h.deps.now=()=>clock;
  await step('w','e',h.deps);
  expect(calls).toBe(1);expect(h.row.status).toBe('planning');expect(h.row.tasks[0]?.status).toBe('pending');expect(h.charges).toBe(5);
  for(const delay of [60_000,300_000,900_000]){clock+=delay;await step('w','e',h.deps);}
  expect(calls).toBe(4);expect(h.row.status).toBe('paused');expect(h.row.tasks[0]?.status).toBe('unknown');expect(h.charges).toBe(20);});
 test('backing-off job is skipped until its nextAttemptAt passes',async()=>{let calls=0;const h=harness(async()=>({execute:async()=>{calls++;throw new Error('x');}}));h.set({...fixture(),tasks:[{id:'t',kind:'analysis',target:'v',status:'pending',attempts:1,charged:0,nextAttemptAt:5000}]});expect(await step('w','e',h.deps)).toBe(false);expect(calls).toBe(0);expect(h.charges).toBe(0);});
 test('preparation failures also consume the retry budget',async()=>{let calls=0;let clock=1000;const h=harness(async()=>{calls++;throw new SafeFailure('media_unavailable_403');});h.deps.now=()=>clock;
  for(const delay of [0,60_000,300_000,900_000]){clock+=delay;await step('w','e',h.deps);}
  expect(calls).toBe(4);expect(h.row.status).toBe('failed');expect(h.row.tasks[0]?.status).toBe('failed');});
});
describe('validation',()=>{
 test('bounded requests, keys and source duplicates',()=>{const b={workspaceId:'w',videoIds:['v'],instructions,variantCount:2,slideCount:3,maxCredits:50,idempotencyKey:'12345678'};expect(Create.safeParse(b).success).toBe(true);for(const extra of [{videoIds:['v','v']},{variantCount:13},{slideCount:2},{idempotencyKey:'a'}, {maxCredits:NaN},{extra:true}])expect(Create.safeParse({...b,...extra}).success).toBe(false);});
 test('retry accepts taskIds for per-job manual retry',()=>{expect(Retry.safeParse({workspaceId:'w',idempotencyKey:'12345678',taskIds:['t1']}).success).toBe(true);expect(Retry.safeParse({workspaceId:'w',idempotencyKey:'12345678',taskIds:[]}).success).toBe(false);expect(Retry.safeParse({workspaceId:'w',idempotencyKey:'12345678',taskIds:['t1'],variantIds:['v1']}).success).toBe(true);});
 test('controlled exact one-variable delta and locked constraints',()=>{const e=fixture();const base={title:'A',hypothesis:'baseline',changedVariables:[],brief};const variant={title:'B',hypothesis:'More clicks',changedVariables:[{name:'hook' as const,value:'New hook'}],brief:{...brief,hook:'New hook'}};expect(()=>validateVariants(e,[base,variant])).not.toThrow();expect(()=>validateVariants(e,[base,{...variant,brief:{...variant.brief,cta:'Different'}}])).toThrow('unapproved_variable');expect(()=>validateVariants(e,[base,{...variant,brief:{...variant.brief,lockedConstraints:[]}}])).toThrow('Slide count');});
 test('reports require exact source quote and frequency',()=>{const p={id:'p',name:'Cup',description:'Cup pattern',sourceIds:['v'],confidence:0.8,frequency:1,evidence:[{videoId:'v',location:'second:0',observation:'A cup'}]};expect(()=>validateReport({summary:'Cup',patterns:[p]},[result])).not.toThrow();expect(()=>validateReport({summary:'Cup',patterns:[{...p,evidence:[{...p.evidence[0]!,observation:'Invented'}]}]},[result])).toThrow('Evidence must quote');expect(()=>validateReport({summary:'Cup',patterns:[{...p,frequency:2}]},[result])).toThrow('invalid_source_frequency');});
});
