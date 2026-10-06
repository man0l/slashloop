// Story feedback loop: a rendered slide is verified against the SAME per-slide
// contract the render request used, gets AT MOST ONE corrective render, and a
// failed or unverified check can never complete the slide (SLA-430 D7/D8).
import { describe, expect, test } from 'bun:test';
import { prepare, resolveQaVerdict, TerminalFailure } from './providers.js';
import type { Experiment, SlideVerification, Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';

const instructions={goal:'Sell tea',brand:'Tea',audience:'Adults',language:'English',direction:'Calm',lockedConstraints:[],variables:['hook' as const],mode:'controlled' as const};
const brief={concept:'Tea routine',hook:'Take a break',character:'Adult',visualStyle:'Warm',caption:'Tea time',cta:'',lockedConstraints:[],slides:[{role:'hook',scene:'A steaming cup on a wooden table by a window',overlayText:'Take a break'},{role:'body',scene:'Hands holding the cup',overlayText:'Breathe'},{role:'end',scene:'Empty cup, calm morning',overlayText:''}]};
function fixture():Experiment{
  const v={id:'v1',revision:1,status:'draft',title:'B',hypothesis:'h',changedVariables:[],brief,frozenBrief:brief,slides:[]};
  return {id:'e',workspaceId:'w',status:'generating',version:1,createdAt:'',updatedAt:'',instructions,variantCount:1,slideCount:3,maxCredits:100,creditsCharged:5,report:{summary:'S'},inputs:[],variants:[v],error:null,generationBasis:'text-directed',assetPolicy:'retained',tasks:[{id:'t0',kind:'slide',target:'v1',index:0,status:'pending',attempts:0,charged:10}],commands:{},allowPartial:false,createFingerprint:'x'} as unknown as Experiment;
}
const pass=(checks=1):SlideVerification=>({verdict:'pass',reasons:[],checks:Array.from({length:checks},(_,i)=>({check:`c${i}`,status:'pass' as const})),contractHash:'',corrected:false,attempts:1});
const fail=(reason:string):SlideVerification=>({verdict:'fail',reasons:[reason],checks:[{check:'casting target',status:'fail',reason}],contractHash:'',corrected:false,attempts:1});
const errored=(reason:string):SlideVerification=>({verdict:'error',reasons:[reason],checks:[],contractHash:'',corrected:false,attempts:1});

function deps(overrides:Record<string,unknown>={}){
  const counts={renders:0};
  const base={
    findSources:async()=>[] as never[],
    generateImage:async(opts:{prompt:string})=>{counts.renders++;return {buffer:Buffer.alloc(600,counts.renders),contentType:'image/jpeg',costUsd:0.01};},
    upload:async()=>({path:'p',sizeBytes:1}),
    describeCandidates:async()=>[{id:'c0',description:'cup on table',medium:'photograph',textBlocks:1,overdesigned:false}],
    classify:async()=>({choice:'c0',confidence:0.5}),
    generateBriefCandidates:async()=>{throw new Error('not used');},
    jevScores:async()=>{throw new Error('not used');},
  };
  return {...base,...overrides,counts} as unknown as Parameters<typeof prepare>[2] & {counts:{renders:number}};
}
async function run(render:Parameters<typeof prepare>[2]){
  process.env.OPENROUTER_API_KEY='test';
  process.env.R2_THUMB_PUBLIC_BASE='https://thumbs.test';
  const prepared=await prepare(fixture(),{id:'t0',kind:'slide',target:'v1',index:0,attempts:0,charged:10} as unknown as Task,render);
  return await prepared.execute() as any;
}

describe('verified success requires a schema-valid composite pass',()=>{
  test('passing QA ships directly without a second render',async()=>{
    const render=deps({verifyStory:async()=>pass(3)});
    const result=await run(render);
    expect(render.counts.renders).toBe(3); // single fanout wave, no corrective render
    expect(result.story).toMatchObject({verdict:'pass',reasons:[],corrected:false,attempts:1});
  });

  test('one corrective render after a failure, and the corrected pass ships',async()=>{
    const render=deps({verifyStory:async(opts:{contract:SlideContract;candidate:Buffer})=>{
      // First attempt (fills 0x01) misses the subject; the corrective one (0x02) passes.
      return opts.candidate[0]===1?fail('the steaming cup is missing'):pass(3);
    }});
    const result=await run(render);
    expect(render.counts.renders).toBe(6); // fanout 3 initial wave + fanout 3 corrective wave
    expect(result.story).toMatchObject({verdict:'pass',corrected:true,attempts:2});
    expect(result.prompt).toContain('CORRECTIVE QA FEEDBACK');
    expect(result.prompt).toContain('the steaming cup is missing');
    expect(JSON.stringify(result.fanout.judge)).toContain('storyRetry');
  });

  test('render and QA receive the identical contract record and hash',async()=>{
    const seen:SlideContract[]=[];
    let promptContract='';
    const render=deps({
      generateImage:async(opts:{prompt:string;referenceUrl?:string})=>{promptContract=opts.prompt;render.counts.renders++;return {buffer:Buffer.alloc(600,render.counts.renders),contentType:'image/jpeg',costUsd:0};},
      verifyStory:async(opts:{contract:SlideContract})=>{seen.push(opts.contract);return pass(2);},
    });
    await run(render);
    expect(seen).toHaveLength(1);
    expect(promptContract).toContain(seen[0]!.contractHash);
    expect(promptContract).toContain(JSON.stringify(seen[0]!.overlay.text).slice(1,-1));
  });

  test('persistent composite failure uploads no deliverable and cannot complete',async()=>{
    let uploaded=0;
    const render=deps({upload:async()=>{uploaded++;return {path:'p'};},verifyStory:async()=>fail('gaze is looking left not right')});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('failed');
    expect(uploaded).toBe(0);
    // Auditable QA survives the failure, including the residual lock violation.
    const audit=(err as TerminalFailure).audit as any;
    expect(audit.verdict).toBe('fail');
    expect(audit.reasons).toContain('gaze is looking left not right');
    expect(audit.checks[0].status).toBe('fail');
    expect(audit.prompt).toContain('CORRECTIVE QA FEEDBACK');
  });

  test('a checker exception is an explicit failure, never a pass',async()=>{
    let uploaded=0;
    const render=deps({upload:async()=>{uploaded++;return {path:'p'};},verifyStory:async()=>{throw new Error('checker exploded');}});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect((err as TerminalFailure).message).toContain('story_unverified');
    expect(uploaded).toBe(0);
  });

  test('a transient checker transport failure is retryable, never terminal (SLA-515)',async()=>{
    for(const message of ['The operation timed out.','OpenRouter returned no content']){
      let uploaded=0;
      const render=deps({upload:async()=>{uploaded++;return {path:'p'};},verifyStory:async()=>{throw new Error(message);}});
      const err=await run(render).catch(e=>e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TerminalFailure);
      expect((err as Error).message).toContain(message);
      expect(uploaded).toBe(0);
    }
  });

  test('a checker that returns no per-check verdict is unverified, never a pass',async()=>{
    let uploaded=0;
    // The historical {ok:true} shape must not complete a slide.
    const render=deps({upload:async()=>{uploaded++;return {path:'p'};},verifyStory:async()=>({ok:true,reasons:[]}) as never});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect(uploaded).toBe(0);
  });

  test('a verified failure is re-rendered up to 3 attempts in total, then stops',async()=>{
    // Attempt 1 fails QA AND is off-style; every correction also fails.
    const render=deps({describeCandidates:async()=>[{id:'c0',description:'app UI dashboard',overdesigned:true}],verifyStory:async()=>fail('overlay text cropped')});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).audit).toMatchObject({attempts:3,corrected:true});
    expect(render.counts.renders).toBe(9); // 3 attempts x fanout 3
    expect(((err as TerminalFailure).audit as { prompt: string }).prompt).toContain('attempt 3 of at most 3');
  });

  test('EXPERIMENT_QA_MAX_ATTEMPTS bounds the attempts',async()=>{
    process.env.EXPERIMENT_QA_MAX_ATTEMPTS='2';
    try{
      const render=deps({verifyStory:async()=>fail('overlay text cropped')});
      const err=await run(render).catch(e=>e);
      expect((err as TerminalFailure).audit).toMatchObject({attempts:2});
      expect(render.counts.renders).toBe(6);
      process.env.EXPERIMENT_QA_MAX_ATTEMPTS='1';
      const once=deps({verifyStory:async()=>fail('overlay text cropped')});
      await run(once).catch(e=>e);
      expect(once.counts.renders).toBe(3);
    }finally{delete process.env.EXPERIMENT_QA_MAX_ATTEMPTS;}
  });

  test('a later attempt that verifies ships and records the attempt count',async()=>{
    let n=0;
    const render=deps({verifyStory:async()=>(++n<3?fail('overlay text cropped'):pass(2))});
    const result=await run(render);
    expect(result.story).toMatchObject({verdict:'pass',corrected:true,attempts:3});
    expect(render.counts.renders).toBe(9);
  });

  test('a checker error gets no blind corrective render',async()=>{
    const render=deps({verifyStory:async()=>errored('qa_missing_checks')});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect(render.counts.renders).toBe(3); // no correction after an unverifiable check
  });

  test('a verified pass is never corrected even when the wave is off-style',async()=>{
    const render=deps({describeCandidates:async()=>[{id:'c0',description:'app UI dashboard',overdesigned:true}],verifyStory:async()=>pass(2)});
    const result=await run(render);
    expect(result.story).toMatchObject({verdict:'pass',attempts:1});
    expect(render.counts.renders).toBe(3);
  });
});

// SLA-545: hard/soft verdicts, the retry bound, QA mode and readable reasons.
const contractChecks=['the on-image overlay matches exactly: "Hi"','the medium is photograph',"the subject's hair is unchanged: \"dark hair\"",'the story beat for role "hook" is visible'];
const softSet=new Set(contractChecks.filter(c=>c.includes('hair')||c.includes('story beat')));
const answer=(status:Record<string,'pass'|'fail'|'unknown'>,reasons:string[]=['the statue looks left and matches the role'])=>({
  checks:contractChecks.map(check=>({check,status:status[check]??'pass',reason:`${status[check]??'pass'} reason`})),reasons,
});
const verdictOf=(a:unknown)=>resolveQaVerdict(a,'h',false,1,contractChecks,softSet);

describe('hard and soft checks',()=>{
  test('soft unknown passes with a warning',()=>{
    const v=verdictOf(answer({[contractChecks[2]!]:'unknown'}));
    expect(v.verdict).toBe('pass');
    expect(v.reasons).toEqual([]);
    expect(v.warnings?.[0]).toContain('hair is unchanged');
  });
  test('hard unknown is an error that a re-render may fix',()=>{
    const v=verdictOf(answer({[contractChecks[1]!]:'unknown'}));
    expect(v.verdict).toBe('error');
    expect(v.rerenderable).toBe(true);
  });
  test('any hard fail is a fail, even beside soft passes',()=>{
    const v=verdictOf(answer({[contractChecks[0]!]:'fail'}));
    expect(v.verdict).toBe('fail');
    expect(v.softOnly).toBe(false);
  });
  test('a soft-only fail is marked softOnly',()=>{
    const v=verdictOf(answer({[contractChecks[3]!]:'fail'}));
    expect(v.verdict).toBe('fail');
    expect(v.softOnly).toBe(true);
  });
  test('the reason names the failing check, not the model free text',()=>{
    const v=verdictOf(answer({[contractChecks[1]!]:'fail'},['the statue matches stated male role and left gaze']));
    expect(v.reasons[0]).toBe('the medium is photograph: fail reason');
    expect(v.reasons.join(' ')).not.toContain('statue');
  });
  test('a coverage problem is still not rerenderable',()=>{
    const v=resolveQaVerdict({checks:[{check:contractChecks[0],status:'pass'}]},'h',false,1,contractChecks,softSet);
    expect(v.verdict).toBe('error');
    expect(v.rerenderable).toBeUndefined();
  });
});

describe('prepare() with soft checks and QA mode',()=>{
  const withSoft=(v:Partial<SlideVerification>)=>({...fail('x'),...v});
  const softFail=()=>withSoft({verdict:'fail',softOnly:true,reasons:["the subject's hair is unchanged: \"dark hair\": fail reason"],checks:[{check:"the subject's hair is unchanged",status:'fail',reason:'fail reason',severity:'soft'}]});
  test('hard unknown re-renders to the bound, then fails naming the check',async()=>{
    const render=deps({verifyStory:async()=>({verdict:'error',reasons:['the medium is photograph: unknown reason'],checks:[{check:'the medium is photograph',status:'unknown',reason:'unknown reason',severity:'hard'}],contractHash:'',corrected:false,attempts:1,rerenderable:true})});
    const err=await run(render).catch(e=>e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect((err as Error).message).toBe('story_unverified:the medium is photograph: unknown reason');
    expect(render.counts.renders).toBe(9);
  });
  test('warn mode ships a soft-only failure after one correction, with warnings',async()=>{
    const render=deps({verifyStory:async()=>softFail()});
    const result=await run(render);
    expect(render.counts.renders).toBe(6);
    expect(result.story).toMatchObject({verdict:'pass',attempts:2});
    expect(result.story.warnings[0]).toContain('soft_check_failed:');
  });
  test('enforce mode keeps a soft-only failure terminal, naming the check',async()=>{
    process.env.EXPERIMENT_QA_MODE='enforce';
    try{
      const err=await run(deps({verifyStory:async()=>softFail()})).catch(e=>e);
      expect(err).toBeInstanceOf(TerminalFailure);
      expect((err as Error).message).toContain("story_check_failed:the subject's hair is unchanged: fail reason");
    }finally{delete process.env.EXPERIMENT_QA_MODE;}
  });
  test('off mode never calls the checker',async()=>{
    process.env.EXPERIMENT_QA_MODE='off';
    try{
      let calls=0;
      const render=deps({verifyStory:async()=>{calls++;return fail('x');}});
      const result=await run(render);
      expect(calls).toBe(0);
      expect(result.story).toMatchObject({verdict:'skipped',attempts:0});
    }finally{delete process.env.EXPERIMENT_QA_MODE;}
  });
  test('a soft unknown ships and the warning rides on the audit',async()=>{
    const render=deps({verifyStory:async()=>withSoft({verdict:'pass',reasons:[],warnings:['unverified:the story beat: unknown']})});
    const result=await run(render);
    expect(result.story.verdict).toBe('pass');
    expect(result.story.warnings).toEqual(['unverified:the story beat: unknown']);
    expect(render.counts.renders).toBe(3);
  });
});
