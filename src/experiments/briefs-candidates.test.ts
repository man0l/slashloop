import { expect, test } from 'bun:test';
import { prepare } from './providers.js';
import type { Experiment, Task, Proposal } from './schema.js';

const baseBrief = { concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', cta: '', lockedConstraints: [], slides: [
  { role: 'hook', scene: 'A studio', overlayText: '' }, { role: 'body', scene: 'A gym', overlayText: '' }, { role: 'cta', scene: 'A mirror', overlayText: '' }] };

test('briefs stage: 20 candidates generated, Jev ranks them, top variants join the baseline', async () => {
  const mkProposal = (i: number) => {
    const hook = i === 0 ? 'Start here' : `Hook variant ${i}`;
    return { title: `V${i}`, hypothesis: 'It will resonate', changedVariables: i === 0 ? [] : [{ name: 'hook' as const, value: hook }], brief: { ...baseBrief, hook } };
  };
  const baseline = mkProposal(0);
  const candidates = Array.from({ length: 20 }, (_, i) => mkProposal(i + 1));
  const e = {
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', creditsCharged: 0, maxCredits: 100,
    instructions: { goal: 'Go viral', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 3, slideCount: 3, report: { summary: 'S' }, error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    inputs: [{ videoId: 'v', status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [{ location: 'second:0', observation: 'A cup' }] }],
    variants: [], commands: {}, allowPartial: false, createFingerprint: 'x', styleFormula: null,
    tasks: [{ id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment;
  const mediumInstructions: string[] = [];
  const deps = {
    findSources: async () => [] as never[],
    generateImage: async () => { throw new Error('not used'); },
    upload: async () => ({ path: 's', sizeBytes: 1 }),
    describeCandidates: async () => [] as never[],
    classify: async (_state: unknown, instructions: string) => {
      mediumInstructions.push(instructions);
      return instructions.includes('visual language') ? { value: 'photograph' } : { value: 'minimal' };
    },
    generateBriefCandidates: async () => ({ baseline, candidates }),
    jevScores: async () => Object.fromEntries(candidates.map((_, i) => [`c${i}`, { value: i === 7 ? 0.99 : 0.1 }])),
  };
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const result = await prepared.execute() as Proposal[];
  expect(e.styleFormula).toEqual({ medium: 'photograph', density: 'minimal' });
  expect(result).toHaveLength(3);
  expect(result[0]!.brief.hook).toBe('Start here'); // baseline always rides along
  expect(result[1]!.brief.hook).toBe('Hook variant 8'); // Jev's top-scored candidate
  expect(result[2]!.brief.hook).toBe('Hook variant 1'); // next best in grok order
});
