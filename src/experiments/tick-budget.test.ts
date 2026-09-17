import { expect, test } from 'bun:test';
import { tick } from './engine.js';
import { withD1Budget, countD1Queries, remainingD1Queries } from '../cf/d1-budget.js';

function harness() {
  let calls = 0;
  let scans = 0;
  return {
    deps: {
      candidates: async () => { scans++; countD1Queries(1); return [{id:'e', workspaceId:'w'}]; },
      step: async () => { calls++; countD1Queries(10); return true; },
      remaining: remainingD1Queries,
      now: () => 0,
    },
    get calls() { return calls; },
    get scans() { return scans; },
  };
}

test('exact boundary includes the candidate query: nine prior queries admit, ten defer', async () => {
  for (const prior of [9, 10]) {
    const h=harness();
    await withD1Budget(async () => {
      for(let i=0;i<prior;i++)countD1Queries(1);
      expect(await tick(120000,h.deps)).toEqual(prior===9?{steps:1,active:true}:{steps:0,active:false});
      expect(h.calls).toBe(prior===9?1:0);
      expect(h.scans).toBe(prior===9?1:0);
    });
  }
});

test('busy preceding schedulers defer before any experiment DB or paid work', async () => {
  const h=harness();
  await withD1Budget(async () => {
    countD1Queries(15);
    expect(await tick(120000,h.deps)).toEqual({steps:0,active:false});
    expect(h.scans).toBe(0);
    expect(h.calls).toBe(0);
  });
});

test('idle preceding schedulers leave room for one fully reserved step', async () => {
  const h=harness();
  await withD1Budget(async () => {
    countD1Queries(6);
    expect(await tick(120000,h.deps)).toEqual({steps:1,active:true});
    expect(remainingD1Queries()).toBe(33);
  });
});

test('standalone ticks remain capped even without Worker accounting', async () => {
  const h=harness();
  expect(await tick(120000,h.deps)).toEqual({steps:3,active:true});
});
