import { expect, test } from 'bun:test';
import { normalizeBriefCandidates, prepare } from './providers.js';
import { BRIEF_CANDIDATES, validateVariants } from './schema.js';
import type { Experiment, Task, Proposal } from './schema.js';

const baseBrief = { concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', cta: '', lockedConstraints: [], slides: [
  { role: 'hook', scene: 'A studio', overlayText: '' }, { role: 'body', scene: 'A gym', overlayText: '' }, { role: 'cta', scene: 'A mirror', overlayText: '' }] };

test('briefs stage: parameter candidates are Jev-ranked and top variants join the baseline', async () => {
  const mkProposal = (i: number) => {
    const hook = i === 0 ? 'Start here' : `Hook variant ${i}`;
    return { title: `V${i}`, hypothesis: 'It will resonate', changedVariables: i === 0 ? [] : [{ name: 'hook' as const, value: hook }], brief: { ...baseBrief, hook } };
  };
  const baseline = mkProposal(0);
  const candidates = Array.from({ length: BRIEF_CANDIDATES }, (_, i) => mkProposal(i + 1));
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
    jevScores: async () => ({ winner: { choice: 'c7', confidence: 0.7, probabilities: Object.fromEntries(candidates.map((_, i) => [`c${i}`, i === 7 ? 0.5 : i === 0 ? 0.3 : 0.02])) } }),
  };
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { candidates: Array<{ title: string; score: number }>; picked: string[] } };
  expect(e.styleFormula).toEqual({ medium: 'photograph', density: 'minimal' });
  expect(proposals).toHaveLength(3);
  expect(proposals[0]!.brief.hook).toBe('Start here'); // baseline always rides along
  expect(proposals[1]!.brief.hook).toBe('Hook variant 8'); // Jev's top-scored candidate
  expect(proposals[2]!.brief.hook).toBe('Hook variant 1'); // next best in grok order
  expect(briefJudge.candidates).toHaveLength(BRIEF_CANDIDATES);
  expect(briefJudge.picked).toEqual(['V8', 'V1']);
});
test('a one-variant experiment keeps only the baseline instead of failing variant_count', async () => {
  const baseline = { title: 'B', hypothesis: 'h', changedVariables: [] as [], brief: { ...baseBrief } };
  const candidates = Array.from({ length: 8 }, (_, i) => ({ title: `V${i+1}`, hypothesis: 'h', changedVariables: [{ name: 'hook' as const, value: `Hook ${i+1}` }], brief: { ...baseBrief, hook: `Hook ${i+1}` } }));
  const e = {
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', creditsCharged: 0, maxCredits: 100,
    instructions: { goal: 'Go viral', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 1, slideCount: 3, report: { summary: 'S' }, error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    inputs: [{ videoId: 'v', status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [{ location: 'second:0', observation: 'A cup' }] }],
    variants: [], commands: {}, allowPartial: false, createFingerprint: 'x', styleFormula: null,
    tasks: [{ id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment;
  const deps = {
    findSources: async () => [] as never[],
    generateImage: async () => { throw new Error('not used'); },
    upload: async () => ({ path: 's', sizeBytes: 1 }),
    describeCandidates: async () => [] as never[],
    classify: async () => ({ value: 'photograph' }),
    generateBriefCandidates: async () => ({ baseline, candidates }),
    jevScores: async () => ({ winner: { choice: 'c0', confidence: 0.8, probabilities: { c0: 0.9 } } }),
  };
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[] } };
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.title).toBe('B');
  expect(briefJudge.picked).toEqual([]);
});
test('extra grok keys and missing overlayText still expand', () => {
  const parsed = {
    baseline: {
      title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', extra: true,
      slides: [
        { role: 'hook', scene: 'A studio' },
        { role: 'body', scene: 'A gym', overlayText: 'Hi' },
        { role: 'cta', scene: 'A mirror' },
      ],
    },
    candidates: [{ title: 'V1', hypothesis: 'h', extra: 1, changedVariables: [{ name: 'Hook', value: 'Hook 1' }] }],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'] } } as never);
  expect(n.candidates).toHaveLength(1);
  expect(n.candidates[0]!.brief.hook).toBe('Hook 1');
  expect(n.baseline.brief.slides[0]!.overlayText).toBe('');
});
test('top-level storyboard without a nested baseline key still expands', () => {
  const parsed = {
    title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides,
    candidates: [{ title: 'V1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Hook 1' }] }],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'] } } as never);
  expect(n.baseline.title).toBe('B');
  expect(n.candidates).toHaveLength(1);
  expect(n.candidates[0]!.brief.hook).toBe('Hook 1');
});
test('storyboard + parameter deltas expand onto the baseline slides', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'V1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Hook 1' }] },
      { title: 'V1dup', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Hook 1' }] },
      { title: 'V2', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Hook 2' }] },
      { title: 'bad', hypothesis: 'h', changedVariables: [{ name: 'character', value: 'A chef' }] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'] } } as never);
  expect(n.candidates.map(c => c.brief.hook)).toEqual(['Hook 1', 'Hook 2']);
  expect(n.candidates[0]!.brief.slides.map(s => s.scene)).toEqual(n.baseline.brief.slides.map(s => s.scene));
  expect(n.candidates[0]!.brief.character).toBe('An artist');
  expect(n.baseline.changedVariables).toEqual([]);
});

test('call-to-action text is stripped from every candidate and the baseline', async () => {
  const mk = (i: number, cta = `Swipe to keep ${i}`) => ({ title: `V${i}`, hypothesis: 'h', changedVariables: [{ name: 'hook', value: `Hook ${i}` }], brief: { ...baseBrief, hook: `Hook ${i}`, cta, slides: [...baseBrief.slides.slice(0, 2), { role: 'cta', scene: 'A mirror', overlayText: `Tap now ${i}` }] } });
  const baseline = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief, cta: 'Follow for more', slides: [...baseBrief.slides, { role: 'cta', scene: 'A mirror', overlayText: 'Follow now' }] } };
  const normalized = normalizeBriefCandidates({ baseline, candidates: [mk(1), mk(2)] }, 3);
  expect(normalized.baseline.brief.cta).toBe('');
  expect(normalized.candidates.every(c => c.brief.cta === '')).toBe(true);
  for (const c of [normalized.baseline, ...normalized.candidates]) {
    expect(c.brief.slides[c.brief.slides.length - 1]!.overlayText).toBe(''); // no baked-in CTA text
  }
});

test('malformed and duplicate candidates are dropped before Jev ranking', async () => {
  const mk = (i: number) => ({ title: `V${i}`, hypothesis: 'h', changedVariables: [{ name: 'hook', value: `Hook ${i}` }], brief: { ...baseBrief, hook: `Hook ${i}` } });
  const baseline = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief } };
  const candidates = [mk(1), { broken: true } as unknown as ReturnType<typeof mk>, mk(2), mk(1), mk(3), mk(1)];
  const normalized = normalizeBriefCandidates({ baseline, candidates }, 3);
  expect(normalized.candidates.map(c => c.brief.hook).sort()).toEqual(['Hook 1', 'Hook 2', 'Hook 3']); // broken + dupes gone
  const deps = {
    findSources: async () => [] as never[],
    generateImage: async () => { throw new Error('not used'); },
    upload: async () => ({ path: 's', sizeBytes: 1 }),
    describeCandidates: async () => [] as never[],
    classify: async () => ({ value: 'photograph' }),
    generateBriefCandidates: async () => normalized,
    jevScores: async () => ({ winner: { choice: 'c2', confidence: 0.7, probabilities: { c0: 0.3, c1: 0.2, c2: 0.5 } } }),
  };
  const e = { id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', creditsCharged: 0, maxCredits: 100,
    instructions: { goal: 'Go viral', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 3, slideCount: 3, report: { summary: 'S' }, error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    inputs: [{ videoId: 'v', status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [{ location: 'second:0', observation: 'A cup' }] }],
    variants: [], commands: {}, allowPartial: false, createFingerprint: 'x', styleFormula: null,
    tasks: [{ id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }] } as unknown as Experiment;
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[] } };
  expect(proposals).toHaveLength(3);
  expect(proposals[1]!.title).toBe('V3'); // Jev's highest-scoring surviving candidate
  const hooks = proposals.map(p => p.brief.hook);
  expect(new Set(hooks).size).toBe(3); // no duplicates survive into variants
  expect(briefJudge.picked).toEqual(['V3', 'V1']);
});

test('camelCase variable names survive normalization (visualStyle deltas were all rejected)', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'V1', hypothesis: 'h', mechanism: 'm', changedVariables: [{ name: 'hook', value: 'Hook A' }, { name: 'visualStyle', value: 'Harsh flash photography' }] },
      { title: 'V2', hypothesis: 'h', mechanism: 'm', changedVariables: [{ name: 'hook', value: 'Hook B' }, { name: 'visualstyle', value: 'Cold blue tones' }] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook', 'visualStyle'] } } as never);
  expect(n.candidates.map(c => c.brief.visualStyle)).toEqual(['Harsh flash photography', 'Cold blue tones']);
  expect(n.candidates.map(c => c.brief.hook)).toEqual(['Hook A', 'Hook B']);
});

const rewrittenSlides = [
  { role: 'hook', scene: 'A studio, new angle beat', overlayText: 'ANGLE ONE' },
  { role: 'body', scene: 'A gym, proof beat', overlayText: 'THE PROOF' },
  { role: 'cta', scene: 'A mirror', overlayText: '' },
];

test('concept candidates must retell the storyboard — plain and copied storyboards are dropped', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Lazy', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'New angle, same slides' }] },
      { title: 'Copier', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'New angle, copied slides' }], slides: baseBrief.slides },
      { title: 'Real', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'New angle told' }], slides: rewrittenSlides },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['concept'] } } as never);
  expect(n.candidates.map(c => c.title)).toEqual(['Real']);
  expect(n.candidates[0]!.brief.slides.map(s => s.overlayText)).toEqual(['ANGLE ONE', 'THE PROOF', '']);
  expect(n.candidates[0]!.changedVariables.map(c => c.name)).toEqual(['concept']);
});

test('concept variants with retold storyboards validate; copied storyboards are rejected', () => {
  const e = { instructions: { lockedConstraints: [], variables: ['concept'], mode: 'exploration' }, variantCount: 2, slideCount: 3 } as never;
  const base = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief } };
  const good = { title: 'V', hypothesis: 'h', changedVariables: [{ name: 'concept' as const, value: 'New angle' }], brief: { ...baseBrief, concept: 'New angle', slides: rewrittenSlides } };
  expect(() => validateVariants(e, [base, good])).not.toThrow();
  const copied = { ...good, brief: { ...baseBrief, concept: 'New angle' } };
  expect(() => validateVariants(e, [base, copied])).toThrow('identical slide briefs');
});
