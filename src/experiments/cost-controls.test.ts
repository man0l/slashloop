// SLA-546: Grok spend is metered per call family, fan-out and brief pool are
// small and tunable, and a lone candidate never pays for describe + judge.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { describeModel, prepare, SlideMeter } from './providers.js';
import { BRIEF_CANDIDATES, SLIDE_FANOUT, briefCandidateCount, slideFanout } from './schema.js';
import type { Experiment, Task } from './schema.js';

type Row = { workspaceId: string; refId: string; costUsd: number | undefined; usage?: { calls?: number; inputTokens?: number; outputTokens?: number; costUsd?: number } };
let rows: Row[] = [];
beforeEach(() => { rows = []; });
const write = (workspaceId: string, refId: string, costUsd: number | undefined, usage?: Row['usage']) => { rows.push({ workspaceId, refId, costUsd, usage }); };
afterEach(() => { for (const k of ['EXPERIMENT_SLIDE_FANOUT', 'EXPERIMENT_BRIEF_CANDIDATES', 'EXPERIMENT_DESCRIBE_MODEL', 'EXPERIMENT_ANALYSIS_MODEL']) delete process.env[k]; });

describe('tunable cost controls', () => {
  test('defaults: 2 candidates per slide, brief pool floor of 3', () => {
    expect(SLIDE_FANOUT).toBe(2);
    expect(slideFanout({} as never)).toBe(2);
    expect(BRIEF_CANDIDATES).toBe(3);
    expect(briefCandidateCount(2, {} as never)).toBe(3);
    expect(briefCandidateCount(3, {} as never)).toBe(3);
  });
  test('the brief pool always covers variantCount-1, whatever the env says', () => {
    expect(briefCandidateCount(8, {} as never)).toBe(7);
    expect(briefCandidateCount(8, { EXPERIMENT_BRIEF_CANDIDATES: '2' } as never)).toBe(7);
    expect(briefCandidateCount(2, { EXPERIMENT_BRIEF_CANDIDATES: '6' } as never)).toBe(6);
    expect(briefCandidateCount(2, { EXPERIMENT_BRIEF_CANDIDATES: 'junk' } as never)).toBe(3);
  });
  test('slide fan-out env is bounded and ignores junk', () => {
    expect(slideFanout({ EXPERIMENT_SLIDE_FANOUT: '3' } as never)).toBe(3);
    expect(slideFanout({ EXPERIMENT_SLIDE_FANOUT: '1' } as never)).toBe(1);
    expect(slideFanout({ EXPERIMENT_SLIDE_FANOUT: '99' } as never)).toBe(4);
    expect(slideFanout({ EXPERIMENT_SLIDE_FANOUT: '0' } as never)).toBe(2);
    expect(slideFanout({ EXPERIMENT_SLIDE_FANOUT: 'x' } as never)).toBe(2);
  });
  test('the describe model pins on its own and otherwise follows the analysis model', () => {
    expect(describeModel({ EXPERIMENT_DESCRIBE_MODEL: ' cheap/vision ', EXPERIMENT_ANALYSIS_MODEL: 'big/model' } as never)).toBe('cheap/vision');
    expect(describeModel({ EXPERIMENT_ANALYSIS_MODEL: 'big/model' } as never)).toBe('big/model');
    expect(describeModel({} as never)).toBe('x-ai/grok-4.6');
  });
});

describe('SlideMeter', () => {
  test('sub-cent calls add up per kind into one row with call and token counts', async () => {
    const m = new SlideMeter();
    m.sink('describe', { costUsd: 0.004, inputTokens: 1000, outputTokens: 100 });
    m.sink('describe', { costUsd: 0.004, inputTokens: 500, outputTokens: 50 });
    m.sink('qa', { costUsd: 0.002, inputTokens: 800, outputTokens: 120 });
    m.flush('w', 'e:v#0', write);
    expect(rows.map((r) => [r.refId, Math.round((r.costUsd ?? 0) * 1000) / 1000, r.usage])).toEqual([
      ['describe:e:v#0', 0.008, { calls: 2, costUsd: 0.008, inputTokens: 1500, outputTokens: 150 }],
      ['qa:e:v#0', 0.002, { calls: 1, costUsd: 0.002, inputTokens: 800, outputTokens: 120 }],
    ]);
  });
  test('zero-cost calls write nothing', async () => {
    const m = new SlideMeter();
    m.sink('qa', { costUsd: 0 });
    m.flush('w', 'r', write);
    expect(rows).toHaveLength(0);
  });
});

const brief = { concept: 'Tea', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: '', cta: '', lockedConstraints: [], slides: [
  { role: 'hook', scene: 'A cup on a table', overlayText: 'Take a break' }, { role: 'body', scene: 'Hands', overlayText: 'Breathe' }] };
function fixture(): Experiment {
  const v = { id: 'v1', revision: 1, status: 'draft', title: 'B', hypothesis: 'h', changedVariables: [], brief, frozenBrief: brief, slides: [] };
  return { id: 'e', workspaceId: 'w', status: 'generating', version: 1, createdAt: '', updatedAt: '', instructions: { goal: 'g', brand: 'b', audience: 'a', language: 'English', direction: 'd', lockedConstraints: [], variables: ['hook'], mode: 'controlled' }, variantCount: 1, slideCount: 2, maxCredits: 100, creditsCharged: 5, report: { summary: 'S' }, inputs: [], variants: [v], error: null, generationBasis: 'text-directed', assetPolicy: 'retained', tasks: [{ id: 't0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 10 }], commands: {}, allowPartial: false, createFingerprint: 'x' } as unknown as Experiment;
}
const task = { id: 't0', kind: 'slide', target: 'v1', index: 0, attempts: 0, charged: 10 } as unknown as Task;
function deps(opts: { failSecondRender?: boolean } = {}) {
  const counts = { renders: 0, describes: 0, classifies: 0 };
  const render = {
    recordAiCost: write,
    findSources: async () => [] as never[],
    generateImage: async () => {
      counts.renders++;
      if (opts.failSecondRender && counts.renders === 2) throw new Error('provider refused');
      return { buffer: Buffer.alloc(600, counts.renders), contentType: 'image/jpeg', costUsd: 0.01 };
    },
    upload: async () => ({ path: 'p', sizeBytes: 1 }),
    describeCandidates: async (b: Buffer[], _brief: unknown, meter?: (k: string, u: object) => void) => {
      counts.describes++;
      meter?.('describe', { costUsd: 0.004, inputTokens: 900, outputTokens: 90 });
      return b.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}` }));
    },
    classify: async () => { counts.classifies++; return { choice: 'c0', confidence: 0.5 }; },
    generateBriefCandidates: async () => { throw new Error('not used'); },
    jevScores: async () => { throw new Error('not used'); },
    verifyStory: async (o: { contract: { contractHash: string }; meter?: (k: string, u: object) => void }) => {
      o.meter?.('qa', { costUsd: 0.003, inputTokens: 700, outputTokens: 80 });
      return { verdict: 'pass' as const, reasons: [], checks: [{ check: 'c', status: 'pass' as const }], contractHash: o.contract.contractHash, corrected: false, attempts: 1 };
    },
  };
  return { render: render as never, counts };
}
async function run(render: never) {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.R2_THUMB_PUBLIC_BASE = 'https://thumbs.test';
  return await (await prepare(fixture(), task, render)).execute() as { fanout: { requested: number; rendered: number } };
}

describe('a slide meters every paid call', () => {
  test('renders, describe and QA each reach the ledger, and the unchosen render is not free', async () => {
    const { render, counts } = deps();
    const result = await run(render);
    expect(result.fanout).toMatchObject({ requested: 2, rendered: 2 });
    expect(counts).toEqual({ renders: 2, describes: 1, classifies: 1 });
    const byFamily = Object.fromEntries(rows.map((r) => [r.refId.split(':')[0], r]));
    expect(Object.keys(byFamily).sort()).toEqual(['describe', 'qa', 'render-extra', 'slide']);
    expect(byFamily['slide']).toMatchObject({ refId: 'slide:e:v1#0', costUsd: 0.01 });
    expect(byFamily['render-extra']).toMatchObject({ refId: 'render-extra:e:v1#0', costUsd: 0.01 });
    expect(byFamily['describe']!.usage).toMatchObject({ calls: 1, inputTokens: 900, outputTokens: 90 });
    expect(byFamily['qa']!.usage).toMatchObject({ calls: 1, inputTokens: 700, outputTokens: 80 });
  });
  test('one surviving candidate skips describe and the judge', async () => {
    const { render, counts } = deps({ failSecondRender: true });
    const result = await run(render);
    expect(result.fanout).toMatchObject({ requested: 2, rendered: 1 });
    expect(counts).toEqual({ renders: 2, describes: 0, classifies: 0 });
    expect(rows.map((r) => r.refId.split(':')[0]).sort()).toEqual(['qa', 'slide']);
  });
});
