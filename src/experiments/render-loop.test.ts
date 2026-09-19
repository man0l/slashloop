// Story feedback loop: a rendered slide that fails its storyboard QA gets ONE
// corrective re-render and the better attempt ships with the trail recorded.
import { describe, expect, test } from 'bun:test';
import { prepare } from './providers.js';
import type { Experiment, Task } from './schema.js';

const instructions={goal:'Sell tea',brand:'Tea',audience:'Adults',language:'English',direction:'Calm',lockedConstraints:[],variables:['hook' as const],mode:'controlled' as const};
const brief={concept:'Tea routine',hook:'Take a break',character:'Adult',visualStyle:'Warm',caption:'Tea time',cta:'',lockedConstraints:[],slides:[{role:'hook',scene:'A steaming cup on a wooden table by a window',overlayText:'Take a break'},{role:'body',scene:'Hands holding the cup',overlayText:'Breathe'},{role:'end',scene:'Empty cup, calm morning',overlayText:''}]};
function fixture():Experiment{
  const v={id:'v1',revision:1,status:'draft',title:'B',hypothesis:'h',changedVariables:[],brief,frozenBrief:brief,slides:[]};
  return {id:'e',workspaceId:'w',status:'generating',version:1,createdAt:'',updatedAt:'',instructions,variantCount:1,slideCount:3,maxCredits:100,creditsCharged:5,report:{summary:'S'},inputs:[],variants:[v],error:null,generationBasis:'text-directed',assetPolicy:'retained',tasks:[{id:'t0',kind:'slide',target:'v1',index:0,status:'pending',attempts:0,charged:10}],commands:{},allowPartial:false,createFingerprint:'x'} as unknown as Experiment;
}

test('story loop: failed QA triggers corrective re-render and ships the better image',async()=>{
  process.env.OPENROUTER_API_KEY='test';
  const e=fixture();
  let renders=0;const prompts: string[]=[];
  const uploaded:Buffer[]=[];
  const render={
    findSources:async()=>[] as never[],
    generateImage:async(opts:{prompt:string})=>{renders++;prompts.push(opts.prompt);return {buffer:Buffer.alloc(600,renders),contentType:'image/jpeg',costUsd:0.01};},
    upload:async(opts:{body:Buffer})=>{uploaded.push(opts.body);return {path:'p',sizeBytes:1};},
    describeCandidates:async()=>[{id:'c0',description:'cup on table',medium:'photograph',textBlocks:1,overdesigned:false}],
    classify:async()=>({choice:'c0',confidence:0.5}),
    generateBriefCandidates:async()=>{throw new Error('not used');},
    jevScores:async()=>{throw new Error('not used');},
    verifyStory:async(opts:{scene:string;overlay:string;candidate:Buffer})=>{
      // First attempt (fills 0x01) misses the subject; the corrective one (0x02) passes.
      return opts.candidate[0]===1?{ok:false,reasons:['the steaming cup is missing','overlay text cropped']}:{ok:true,reasons:[]};
    },
  };
  const prepared=await prepare(e,{id:'t0',kind:'slide',target:'v1',index:0,attempts:0,charged:10} as unknown as Task,render as never);
  const result=await prepared.execute() as any;
  expect(renders).toBe(6); // fanout 3 initial wave + fanout 3 corrective wave
  expect(uploaded[0]![0]).toBe(4); // first render of the corrective wave wins and ships
  expect(result.story).toEqual({ok:true,reasons:[],corrected:true});
  expect(result.prompt).toContain('CORRECTIVE QA FEEDBACK');
  expect(result.prompt).toContain('the steaming cup is missing');
  const trail=JSON.stringify(result.fanout.judge);
  expect(trail).toContain('storyCheck');
  expect(trail).toContain('storyRetry');
});

test('story loop: passing QA ships directly without a second render',async()=>{
  process.env.OPENROUTER_API_KEY='test';
  const e=fixture();
  let renders=0;
  const render={
    findSources:async()=>[] as never[],
    generateImage:async(opts:{prompt:string})=>{renders++;return {buffer:Buffer.alloc(600,renders),contentType:'image/jpeg',costUsd:0.01};},
    upload:async()=>({path:'p',sizeBytes:1}),
    describeCandidates:async()=>[{id:'c0',description:'cup on table',overdesigned:false}],
    classify:async()=>({choice:'c0',confidence:0.5}),
    generateBriefCandidates:async()=>{throw new Error('not used');},
    jevScores:async()=>{throw new Error('not used');},
    verifyStory:async()=>({ok:true,reasons:[]}),
  };
  const prepared=await prepare(e,{id:'t0',kind:'slide',target:'v1',index:0,attempts:0,charged:10} as unknown as Task,render as never);
  const result=await prepared.execute() as any;
  expect(renders).toBe(3); // single fanout wave, no corrective render
  expect(result.story).toEqual({ok:true,reasons:[],corrected:false});
});
