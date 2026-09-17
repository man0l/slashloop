import { expect, test } from 'bun:test';
import { encodeExperiment, DOCUMENT_BYTES, HISTORY_BYTES, HISTORY_ENTRIES } from './document-budget.js';
import { Brief, type Experiment } from './schema.js';
import { create, save } from './store.js';

function fixture(): Experiment {
  const brief = Brief.parse({concept:'x'.repeat(2000),hook:'x'.repeat(2000),character:'x'.repeat(2000),visualStyle:'x'.repeat(2000),caption:'x'.repeat(2000),cta:'x'.repeat(2000),lockedConstraints:[],slides:Array.from({length:8},()=>({role:'x'.repeat(80),scene:'x'.repeat(2000),overlayText:'x'.repeat(2000)}))});
  return {id:'e',workspaceId:'w',status:'review',version:0,createdAt:'',updatedAt:'',instructions:{goal:'test',brand:'',audience:'',language:'English',direction:'',lockedConstraints:[],variables:['hook'],mode:'controlled'},variantCount:1,slideCount:8,maxCredits:100,creditsCharged:0,report:null,inputs:[],variants:[{id:'v',title:'test',hypothesis:'test',changedVariables:[],brief,revision:1,status:'draft',baselineId:null,generationBasis:'text-directed',history:[],frozenBrief:null,slides:[],error:null}],error:null,generationBasis:'text-directed',assetPolicy:'retained',tasks:[],commands:{},allowPartial:false,createFingerprint:'test'};
}

test('44 large edits keep bounded history and preserve current/frozen briefs',()=>{
  const e=fixture();const v=e.variants[0]!;
  for(let i=0;i<44;i++){
    v.history.push({revision:v.revision++,brief:structuredClone(v.brief)});
    v.brief={...v.brief,hook:`hook ${i}`};
    encodeExperiment(e);
  }
  v.frozenBrief=structuredClone(v.brief);
  const frozen=JSON.stringify(v.frozenBrief);
  expect(Buffer.byteLength(encodeExperiment(e))).toBeLessThan(DOCUMENT_BYTES);
  expect(v.history.length).toBeLessThanOrEqual(HISTORY_ENTRIES);
  expect(v.history.reduce((n,h)=>n+Buffer.byteLength(JSON.stringify(h)),0)).toBeLessThanOrEqual(HISTORY_BYTES);
  expect(JSON.stringify(v.brief)).toBe(frozen);
  expect(JSON.stringify(v.frozenBrief)).toBe(frozen);
});

test('UTF8 and JSON escaping count toward the limit without truncation',()=>{
  for(const text of ['界'.repeat(610000),'\u0001'.repeat(310000)]){
    const e=fixture();e.instructions.direction=text;
    expect(()=>encodeExperiment(e)).toThrow('too large');
    expect(e.instructions.direction).toBe(text);
  }
});

test('store rejects oversized create and paid save before touching the database',async()=>{
  const e=fixture();e.instructions.direction='x'.repeat(DOCUMENT_BYTES);
  await expect(create(e,'create-key')).rejects.toThrow('too large');
  await expect(save(e,2,'charge-ref')).rejects.toThrow('too large');
});

test('claim reserves result room before paid work and settlement releases it',()=>{
  const e=fixture();e.instructions.direction='x'.repeat(700000);
  expect(()=>encodeExperiment(e)).not.toThrow();
  e.tasks=[{id:'t',kind:'briefs',status:'running',attempts:1,charged:2}];
  expect(()=>encodeExperiment(e)).toThrow('too large');
  e.tasks[0]!.status='done';
  expect(()=>encodeExperiment(e)).not.toThrow();
});
