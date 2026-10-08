import { expect, test } from 'bun:test';
import { normalizeBriefCandidates, prepare } from './providers.js';
import { validateVariants } from './schema.js';

const BRIEF_CANDIDATES = 8; // pool size is arbitrary here; the production default is tested in cost-controls.test.ts
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

test('call-to-action text field is stripped; in-count payoff overlays survive', async () => {
  // Real-world shape (experiment 364c3486): slideCount slides, the last one
  // carrying the story's payoff beat ("average european") — story copy, not
  // a CTA. Only the cta TEXT FIELD is stripped; the payoff overlay rides
  // through verbatim onto baseline and candidates.
  const storySlides = [
    { role: 'hook', scene: 'A studio', overlayText: 'HOOK WORDS' },
    { role: 'body', scene: 'A gym', overlayText: 'MIDDLE WORDS' },
    { role: 'payoff', scene: 'A mirror', overlayText: 'THE PAYOFF' },
  ];
  const mk = (i: number, cta = `Swipe to keep ${i}`) => ({ title: `V${i}`, hypothesis: 'h', changedVariables: [{ name: 'hook', value: `Hook ${i}` }], brief: { ...baseBrief, hook: `Hook ${i}`, cta, slides: storySlides } });
  const baseline = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief, cta: 'Follow for more', slides: storySlides } };
  const normalized = normalizeBriefCandidates({ baseline, candidates: [mk(1), mk(2)] }, 3);
  expect(normalized.baseline.brief.cta).toBe('');
  expect(normalized.candidates.every(c => c.brief.cta === '')).toBe(true);
  expect(normalized.baseline.brief.slides[2]!.overlayText).toBe('THE PAYOFF');
  for (const c of normalized.candidates) {
    expect(c.brief.slides[2]!.overlayText).toBe('THE PAYOFF');
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

// Storyline is locked: same scenes/order as the baseline, new overlay copy per angle.
const rewrittenSlides = [
  { role: 'hook', scene: 'A studio', overlayText: 'ANGLE ONE' },
  { role: 'body', scene: 'A gym', overlayText: 'THE PROOF' },
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
  // slide 1's overlay is aligned to the (locked) brief hook — what render will burn in
  expect(n.candidates[0]!.brief.slides.map(s => s.overlayText)).toEqual(['Start here', 'THE PROOF', '']);
  expect(n.candidates[0]!.changedVariables.map(c => c.name)).toEqual(['concept']);
});

test('text-only candidates ignore smuggled storyboard rewrites instead of failing validation', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'V1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Hook A' }], slides: [{ role: 'hook', scene: 'A rewritten studio', overlayText: 'New words' }, { role: 'body', scene: 'A rewritten gym', overlayText: 'More words' }, { role: 'cta', scene: 'A mirror', overlayText: '' }] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'] } } as never);
  expect(n.candidates).toHaveLength(1);
  expect(n.candidates[0]!.brief.hook).toBe('Hook A');
  expect(n.candidates[0]!.brief.slides.map(s => s.scene)).toEqual(n.baseline.brief.slides.map(s => s.scene));
});

test('concept variants with retold storyboards validate; copied storyboards are rejected', () => {
  const e = { instructions: { lockedConstraints: [], variables: ['concept'], mode: 'exploration' }, variantCount: 2, slideCount: 3 } as never;
  const base = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief } };
  const good = { title: 'V', hypothesis: 'h', changedVariables: [{ name: 'concept' as const, value: 'New angle' }], brief: { ...baseBrief, concept: 'New angle', slides: rewrittenSlides } };
  expect(() => validateVariants(e, [base, good])).not.toThrow();
  const copied = { ...good, brief: { ...baseBrief, concept: 'New angle' } };
  expect(() => validateVariants(e, [base, copied])).toThrow('identical slide briefs');
});

// Deltas-only fan-out: concept candidates send overlayTexts, code keeps the baseline scenes.
test('concept overlayTexts merge onto baseline scenes without re-emitting the storyboard', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Angle', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'New angle told' }], overlayTexts: ['Start here', 'ANGLE TWO', ''] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['concept'] } } as never);
  expect(n.candidates.map(c => c.title)).toEqual(['Angle']);
  const brief = n.candidates[0]!.brief;
  expect(brief.slides.map(s => s.scene)).toEqual(n.baseline.brief.slides.map(s => s.scene)); // storyline kept verbatim
  expect(brief.slides.map(s => s.overlayText)).toEqual(['Start here', 'ANGLE TWO', '']); // angle retold, hook locked, no CTA text
  expect(brief.concept).toBe('New angle told'); // the parameter still lands on the brief
});

test('concept candidates with neither slides nor overlayTexts are dropped', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Lazy', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'New angle, no retell' }] },
    ],
  };
  expect(() => normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['concept'] } } as never)).toThrow('brief_candidates_invalid');
});

test('slides candidates cannot ride on overlayTexts alone — structure rewrites need full slides', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Restructure', hypothesis: 'h', changedVariables: [{ name: 'slides', value: 'New structure' }], overlayTexts: ['Start here', 'NEW BEAT', ''] },
    ],
  };
  expect(() => normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['slides'] } } as never)).toThrow('brief_candidates_invalid');
});

test('concept overlayTexts identical to the baseline are dropped as a copied storyboard', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Copier', hypothesis: 'h', changedVariables: [{ name: 'concept', value: 'Same words' }], overlayTexts: ['', '', ''] },
    ],
  };
  expect(() => normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['concept'] } } as never)).toThrow('brief_candidates_invalid');
});

// Hook tests with varySupportingOverlays: scenes stay locked, slides 2..N overlay copy is retold.
test('hook + supporting overlays retells slides 2..N while scenes stay locked', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'H1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'New hook' }], overlayTexts: ['New hook', 'SUPPORT ONE', ''] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'], varySupportingOverlays: true } } as never);
  expect(n.candidates).toHaveLength(1);
  const brief = n.candidates[0]!.brief;
  expect(brief.hook).toBe('New hook');
  expect(brief.slides.map(s => s.scene)).toEqual(n.baseline.brief.slides.map(s => s.scene));
  expect(brief.slides.map(s => s.overlayText)).toEqual(['New hook', 'SUPPORT ONE', '']);
});

test('hook overlayTexts are ignored without the flag — slide-1-hook-only stays the default', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'H1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'New hook' }], overlayTexts: ['New hook', 'SNEAKY', ''] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'] } } as never);
  expect(n.candidates).toHaveLength(1);
  expect(n.candidates[0]!.brief.hook).toBe('New hook');
  expect(n.candidates[0]!.brief.slides.map(s => s.overlayText)).toEqual(['', '', '']);
});

test('hook + supporting overlays still accepts hook-only deltas with no retell', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'H1', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'New hook' }] },
    ],
  };
  const n = normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'], varySupportingOverlays: true } } as never);
  expect(n.candidates).toHaveLength(1);
  expect(n.candidates[0]!.brief.slides.map(s => s.scene)).toEqual(n.baseline.brief.slides.map(s => s.scene));
});

test('hook retell with an unchanged hook and identical overlays tests nothing and is dropped', () => {
  const parsed = {
    baseline: { title: 'B', hypothesis: 'h', concept: 'Guide', hook: 'Start here', character: 'An artist', visualStyle: 'Editorial', caption: '', slides: baseBrief.slides },
    candidates: [
      { title: 'Same', hypothesis: 'h', changedVariables: [{ name: 'hook', value: 'Start here' }], overlayTexts: ['', '', ''] },
    ],
  };
  expect(() => normalizeBriefCandidates(parsed, 3, { instructions: { lockedConstraints: [], variables: ['hook'], varySupportingOverlays: true } } as never)).toThrow('brief_candidates_invalid');
});

test('supporting-overlays proposals validate; rewritten scenes are still rejected', () => {
  const e = { instructions: { lockedConstraints: [], variables: ['hook'], mode: 'controlled', varySupportingOverlays: true }, variantCount: 2, slideCount: 3 } as never;
  const base = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief } };
  const retold = { title: 'V', hypothesis: 'h', changedVariables: [{ name: 'hook' as const, value: 'New hook' }], brief: { ...baseBrief, hook: 'New hook', slides: [{ role: 'hook', scene: 'A studio', overlayText: 'New hook' }, { role: 'body', scene: 'A gym', overlayText: 'SUPPORT' }, { role: 'cta', scene: 'A mirror', overlayText: '' }] } };
  expect(() => validateVariants(e, [base, retold])).not.toThrow();
  const reshot = { ...retold, brief: { ...retold.brief, slides: [{ role: 'hook', scene: 'A different studio', overlayText: 'New hook' }, { role: 'body', scene: 'A gym', overlayText: 'SUPPORT' }, { role: 'cta', scene: 'A mirror', overlayText: '' }] } };
  expect(() => validateVariants(e, [base, reshot])).toThrow('unapproved_variable');
});

test('a 10-variant experiment degrades to the 9 deliverable proposals instead of failing', () => {
  const e = { instructions: { lockedConstraints: [], variables: ['hook'], mode: 'controlled' }, variantCount: 10, slideCount: 3 } as never;
  const base = { title: 'B', hypothesis: 'h', changedVariables: [], brief: { ...baseBrief } };
  const variants = Array.from({ length: 8 }, (_, i) => ({ title: `V${i}`, hypothesis: 'h', changedVariables: [{ name: 'hook' as const, value: `Hook ${i}` }], brief: { ...baseBrief, hook: `Hook ${i}` } }));
  expect(() => validateVariants(e, [base, ...variants])).not.toThrow();
  const extra = { title: 'VX', hypothesis: 'h', changedVariables: [{ name: 'hook' as const, value: 'Hook X' }], brief: { ...baseBrief, hook: 'Hook X' } };
  expect(() => validateVariants(e, [base, ...variants, extra])).not.toThrow();
  expect(() => validateVariants(e, [base, ...variants, extra, { ...extra, title: 'VY', brief: { ...baseBrief, hook: 'Hook Y' } }])).toThrow('variant_count');
});

// SLA-429: deterministic experiment selection — explicit winner precedence,
// score ranking with stable ties, explicit deterministic fallbacks, and
// provenance that matches the effective selection. All mocked, no network.
function selectionFixture(winnerAnswer: unknown, variantCount = 3) {
  const locks = ['keep it calm'];
  const lockedBrief = { ...baseBrief, lockedConstraints: locks };
  const mk = (i: number) => ({ title: `V${i}`, hypothesis: `why ${i}`, changedVariables: [{ name: 'hook' as const, value: `Hook ${i}` }], brief: { ...lockedBrief, hook: `Hook ${i}` } });
  const baseline = { title: 'B', hypothesis: 'h', changedVariables: [] as [], brief: { ...lockedBrief } };
  const candidates = Array.from({ length: 4 }, (_, i) => mk(i + 1));
  const e = {
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', creditsCharged: 0, maxCredits: 100,
    instructions: { goal: 'Go viral', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: locks, variables: ['hook'], mode: 'controlled' },
    variantCount, slideCount: 3, report: { summary: 'R' }, error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    inputs: [{ videoId: 'v', status: 'ready', analysisId: 'a', jobId: null, error: null, coverage: null, evidence: [{ location: 'second:0', observation: 'A cup' }] }],
    variants: [], commands: {}, allowPartial: false, createFingerprint: 'x', styleFormula: null,
    tasks: [{ id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment;
  const seenStates: unknown[] = [];
  const deps = {
    findSources: async () => [] as never[],
    generateImage: async () => { throw new Error('not used'); },
    upload: async () => ({ path: 's', sizeBytes: 1 }),
    describeCandidates: async () => [] as never[],
    classify: async () => ({ value: 'photograph' }),
    generateBriefCandidates: async () => ({ baseline, candidates }),
    jevScores: async (state: unknown) => {
      seenStates.push(state);
      if (winnerAnswer instanceof Error) throw winnerAnswer;
      return { winner: winnerAnswer };
    },
  };
  return { e, deps, seenStates };
}

test('choice-only C7 wins without any probabilities (was: tied at zero, stable sort picked C0)', async () => {
  const { e, deps } = selectionFixture({ choice: 'c3', confidence: 0.7 });
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[]; winner: string | null; fallback: string | null } };
  expect(proposals[1]!.title).toBe('V4'); // explicit c3 winner honored first
  expect(briefJudge.picked).toEqual(['V4', 'V1']); // winner, then stable grok order for the tie
  expect(briefJudge.winner).toBe('c3');
  expect(briefJudge.fallback).toBeNull();
});

test('value-only ID is honored as the explicit winner', async () => {
  const { e, deps } = selectionFixture({ value: 'c2', confidence: 0.6 });
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[]; winner: string | null } };
  expect(proposals[1]!.title).toBe('V3');
  expect(briefJudge.winner).toBe('c2');
});

test('probability ranking orders the rest; full ties keep grok order', async () => {
  const { e, deps } = selectionFixture({ choice: 'c1', confidence: 0.9, probabilities: { c0: 0.1, c1: 0.2, c2: 0.8, c3: 0.8 } });
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[] } };
  expect(proposals[1]!.title).toBe('V2'); // explicit c1 first despite lower probability
  expect(briefJudge.picked).toEqual(['V2', 'V3']); // then top probability, stable tie broken by grok order (c2 before c3)
});

test('invalid ID falls back deterministically with an explicit reason', async () => {
  const { e, deps } = selectionFixture({ choice: 'c9', confidence: 0.5, probabilities: { c2: 0.9 } });
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[]; winner: string | null; fallback: string | null } };
  expect(briefJudge.winner).toBeNull();
  expect(briefJudge.fallback).toBe('invalid_answer:c9');
  expect(briefJudge.picked).toEqual(['V3', 'V1']); // score order, stable ties
  expect(proposals[1]!.title).toBe('V3');
});

test('checker exception keeps grok order with zero scores and records the reason', async () => {
  const { e, deps } = selectionFixture(new Error('typesafe_500'));
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { picked: string[]; candidates: Array<{ score: number }>; fallback: string | null } };
  expect(briefJudge.picked).toEqual(['V1', 'V2']);
  expect(briefJudge.candidates.every(c => c.score === 0)).toBe(true);
  expect(briefJudge.fallback).toContain('typesafe_500');
});

test('saved provenance matches the effective selection: winner, state, report presence', async () => {
  const { e, deps, seenStates } = selectionFixture({ choice: 'c3', confidence: 0.7 });
  const prepared = await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never);
  const { proposals, briefJudge } = await prepared.execute() as { proposals: Proposal[]; briefJudge: { winner: string | null; reportPresent: boolean; state: { candidates: Array<{ id: string; overlays: string[]; storyboard: string[]; hypothesis: string }>; locks: string[]; reportPresent: boolean } } };
  expect(seenStates).toHaveLength(1);
  expect(JSON.stringify(briefJudge.state)).toBe(JSON.stringify(seenStates[0])); // the actual state used is saved
  expect(briefJudge.reportPresent).toBe(true); // report context was present (not awaited)
  expect(briefJudge.state.reportPresent).toBe(true);
  expect(briefJudge.state.locks).toEqual(['keep it calm']);
  const c3 = briefJudge.state.candidates.find(c => c.id === 'c3')!;
  expect(c3.hypothesis).toBe('why 4');
  expect(c3.overlays).toHaveLength(3);
  expect(c3.storyboard).toHaveLength(3);
  expect(proposals[1]!.brief.hook).toBe('Hook 4'); // effective selection agrees with recorded winner c3
});

// SLA-510 defect A: the evidence contract the briefs-stage judge is handed.
// Fixtures are offline and mocked — no provider, no network, no credits.
type JudgeState = {
  original_pattern: string; reportPresent: boolean; original_shots: string[];
  original_evidence: { expectedSlides: number | null; observedSlides: number; missingSlides: number[]; gaps: Array<{ source: string; videoId: string; expected: number | null; missing: number[] }>; complete: boolean; notes: string[]; sufficient: boolean; report: { status: string }; sources: Array<{ source: string; expectedKnown: boolean; slides: Array<{ location: string }> }> };
  candidates: Array<{ id: string; storyboard: string[]; overlays: string[]; storyboardTruncated: boolean; truncatedSlides: string[] }>;
};

/** `observed`/`total`/`locations` let a test build a source that does NOT cover
 *  what it declared. Left unset, the fixture is the shape `compatibleInput`
 *  produces: a declared total and dense zero-based `slide:` locations. */
function evidenceFixture(opts: { report: { summary: string } | null; slides: number; observed?: number; total?: number | null; longOverlayAt?: number }) {
  const slides = Array.from({ length: opts.slides }, (_, i) => ({ role: 's', scene: `scene ${i + 1}`, overlayText: `copy ${i + 1}` }));
  // Shared by the baseline and every candidate, so no proposal changes `slides`
  // and validation stays about the hook only.
  if (opts.longOverlayAt !== undefined) slides[opts.longOverlayAt]!.overlayText = 'y'.repeat(900);
  const brief = { ...baseBrief, slides };
  const total = opts.total === undefined ? opts.slides : opts.total;
  const observed = opts.observed ?? opts.slides;
  const e = {
    id: 'e', workspaceId: 'w', status: 'planning', version: 0, createdAt: '', updatedAt: '', creditsCharged: 0, maxCredits: 100,
    instructions: { goal: 'Go viral', brand: '', audience: 'looksmaxxers', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 3, slideCount: opts.slides, report: opts.report, error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    inputs: [{ videoId: 'v', status: 'ready', analysisId: 'a', jobId: null, error: null,
      coverage: { basis: 'slideshow+caption', observed, total, complete: observed === total },
      evidence: Array.from({ length: observed }, (_, i) => ({ location: `slide:${i}`, observation: `source slide ${i}` })) }],
    variants: [], commands: {}, allowPartial: false, createFingerprint: 'x', styleFormula: null,
    tasks: [{ id: 't', kind: 'briefs', status: 'pending', attempts: 0, charged: 0 }],
  } as unknown as Experiment;
  const calls: Array<{ state: unknown; instructions: string }> = [];
  const deps = {
    findSources: async () => [] as never[],
    generateImage: async () => { throw new Error('not used'); },
    upload: async () => ({ path: 's', sizeBytes: 1 }),
    describeCandidates: async () => [] as never[],
    classify: async () => ({ value: 'photograph' }),
    generateBriefCandidates: async () => ({
      baseline: { title: 'B', hypothesis: 'h', changedVariables: [] as [], brief: { ...brief } },
      candidates: Array.from({ length: 4 }, (_, i) => ({ title: `V${i}`, hypothesis: `why ${i}`, changedVariables: [{ name: 'hook' as const, value: `Hook ${i}` }], brief: { ...brief, hook: `Hook ${i}` } })),
    }),
    jevScores: async (state: unknown, questions: { winner: { instructions: string } }) => {
      calls.push({ state, instructions: questions.winner.instructions });
      return { winner: { choice: 'c0', confidence: 0.5, probabilities: { c0: 0.4 } } };
    },
  };
  return { e, deps, calls };
}

test('every source slide reaches the judge, with later slides included', async () => {
  const { e, deps, calls } = evidenceFixture({ report: null, slides: 7 });
  await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute();
  const state = calls[0]!.state as JudgeState;
  // The old state described two slides of seven and said nothing about the rest.
  expect(state.original_evidence.sources[0]!.slides.map(s => s.location)).toHaveLength(7);
  expect(state.original_shots).toHaveLength(7);
  expect(state.original_evidence.expectedSlides).toBe(7);
  expect(state.original_evidence.missingSlides).toEqual([]);
  expect(state.original_evidence.complete).toBe(true);
});

test('an absent report is explicit absence and the judge is still asked', async () => {
  const { e, deps, calls } = evidenceFixture({ report: null, slides: 3 });
  const { briefJudge } = await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute() as { briefJudge: { reportPresent: boolean; fallback: string | null; state: JudgeState } };
  expect(calls).toHaveLength(1); // source slides exist, so the question is answerable
  expect(briefJudge.reportPresent).toBe(false);
  expect(briefJudge.fallback).toBeNull(); // a real answer, not an evidence fallback
  expect(briefJudge.state.original_pattern).toBe('');
  expect(briefJudge.state.original_evidence.notes.join(' ')).toContain('independently');
  expect(calls[0]!.instructions).toContain('original_evidence.notes');
});

test('a present report contributes its summary to the same state', async () => {
  const { e, deps, calls } = evidenceFixture({ report: { summary: 'hooks are negative questions' }, slides: 3 });
  await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute();
  const state = calls[0]!.state as JudgeState;
  expect(state.reportPresent).toBe(true);
  expect(state.original_pattern).toBe('hooks are negative questions');
  expect(state.original_evidence.report.status).toBe('present');
});

test('a source that did not deliver every declared slide records the gap', async () => {
  // The source declares seven slides and delivered two. The judge is still
  // called — there IS an original to rank against — but the recorded scores are
  // marked incomplete and the gap is attributed to the source that has it.
  const { e, deps, calls } = evidenceFixture({ report: { summary: 'S' }, slides: 7, observed: 2 });
  const { briefJudge } = await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute() as { briefJudge: { evidenceComplete: boolean; candidateTruncated: boolean } };
  const state = calls[0]!.state as JudgeState;
  expect(state.original_evidence.expectedSlides).toBe(7);
  expect(state.original_evidence.missingSlides).toEqual([2, 3, 4, 5, 6]);
  expect(state.original_evidence.gaps).toEqual([{ source: 's0', videoId: 'v', expected: 7, missing: [2, 3, 4, 5, 6] }]);
  expect(state.original_evidence.complete).toBe(false);
  expect(state.original_evidence.sufficient).toBe(true);
  expect(briefJudge.evidenceComplete).toBe(false);
  expect(briefJudge.candidateTruncated).toBe(false);
});

test('a source with no declared total is not reported as complete', async () => {
  // A video source declares no slide total. Everything it recorded is retained,
  // but full source coverage cannot be confirmed, so it is not "complete".
  const { e, deps, calls } = evidenceFixture({ report: { summary: 'S' }, slides: 3, total: null });
  const { briefJudge } = await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute() as { briefJudge: { evidenceComplete: boolean } };
  const state = calls[0]!.state as JudgeState;
  expect(state.original_evidence.sources[0]!.expectedKnown).toBe(false);
  expect(state.original_evidence.expectedSlides).toBeNull();
  expect(state.original_evidence.complete).toBe(false);
  expect(state.original_evidence.notes.join(' ')).toContain('declared no slide total');
  expect(briefJudge.evidenceComplete).toBe(false);
});

test('a cut candidate overlay makes the whole evidence block incomplete', async () => {
  // The candidate storyboards are part of the judge's evidence block. A cut
  // overlay used to be recorded as intact, so the block was called complete
  // while the judge read a truncated instruction.
  // The hook is an unlocked variable, so its overlay is slide 1's copy.
  const { e, deps, calls } = evidenceFixture({ report: { summary: 'S' }, slides: 3, longOverlayAt: 1 });
  const { briefJudge } = await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute() as { briefJudge: { evidenceComplete: boolean; candidateTruncated: boolean } };
  const state = calls[0]!.state as JudgeState;
  expect(state.original_evidence.complete).toBe(true); // the source evidence itself is whole
  expect(state.candidates[0]!.overlays[1]!.length).toBe(400);
  expect(state.candidates[0]!.storyboardTruncated).toBe(true);
  expect(state.candidates[0]!.truncatedSlides).toEqual(['s']);
  expect(briefJudge.candidateTruncated).toBe(true);
  expect(briefJudge.evidenceComplete).toBe(false);
});

test('with no evidence at all the judge is not called and the reason is recorded', async () => {
  const { e, deps, calls } = evidenceFixture({ report: null, slides: 0 });
  e.inputs = [];
  const { proposals, briefJudge } = await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute() as { proposals: Proposal[]; briefJudge: { picked: string[]; candidates: Array<{ score: number }>; winner: string | null; fallback: string } };
  expect(calls).toHaveLength(0); // no confident ranking about an absent original
  expect(briefJudge.winner).toBeNull();
  expect(briefJudge.fallback).toContain('insufficient_evidence');
  expect(briefJudge.candidates.every(c => c.score === 0)).toBe(true);
  expect(briefJudge.picked).toEqual(['V0', 'V1']); // generated order, deterministic
  expect(proposals).toHaveLength(3);
});

test('every candidate slide reaches the judge, flagged when a scene was truncated', async () => {
  const { e, deps, calls } = evidenceFixture({ report: { summary: 'S' }, slides: 7 });
  await (await prepare(e, { id: 't', kind: 'briefs' } as Task, deps as never)).execute();
  const state = calls[0]!.state as JudgeState;
  for (const candidate of state.candidates) {
    expect(candidate.storyboard).toHaveLength(7);
    // Every slide is described, including the last; the fixture's identity lock
    // wraps each later beat, which is exactly why a per-slide list is needed.
    expect(candidate.storyboard[6]).toContain('scene 7');
    expect(candidate.storyboardTruncated).toBe(false);
  }
});
