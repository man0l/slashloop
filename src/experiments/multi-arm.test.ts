import { describe, expect, test } from 'bun:test';
import { proposalsFromContract } from './contract-flow.js';
import { armsOf, normalizeContract, planAlternates, poolNeeds, tagLocks, type ArmField, type ContractInput } from './resolved-contract.js';
import { validateVariants } from './schema.js';
import { universalLocks } from './source-format.js';

const slide = (overlayText: string, scene = 'a scene') => ({ overlayText, arcLevel: 'none', scene, composition: 'centred', visibleChange: '' });
const key = (p: { axes: Array<{ variable: string; pick: number }> }) => p.axes.map(a => `${a.variable}${a.pick}`).join('+');

describe('planAlternates', () => {
  test('controlled: one variable per alternate, round-robin, values advance per variable', () => {
    expect(planAlternates(['hook', 'cta'], 'controlled', 5).map(key)).toEqual(['hook0', 'cta0', 'hook1', 'cta1', 'hook2']);
  });

  test('exploration: one clean control per variable first, then combinations, never a duplicate', () => {
    const plans = planAlternates(['hook', 'character', 'concept', 'scene'], 'exploration', 11);
    expect(plans).toHaveLength(11);
    expect(plans.slice(0, 4).map(p => p.axes.length)).toEqual([1, 1, 1, 1]);
    expect(plans.slice(4).every(p => p.axes.length >= 2)).toBe(true);
    expect(new Set(plans.map(key)).size).toBe(11);
  });

  test('a short pool caps the plan instead of repeating a combination', () => {
    expect(planAlternates(['hook'], 'controlled', 6, { hook: 2 })).toHaveLength(2);
    expect(planAlternates(['hook'], 'exploration', 3, { hook: 1 })).toHaveLength(1);
  });

  test('slides folds into concept when both are variables', () => {
    expect(planAlternates(['concept', 'slides'], 'controlled', 2).map(p => p.axes[0]!.variable)).toEqual(['concept', 'concept']);
  });

  test('poolNeeds asks only for as many distinct values as the plan consumes', () => {
    expect(poolNeeds({ variables: ['hook', 'cta'], mode: 'controlled', alternates: 5 })).toEqual({ hook: 3, cta: 2 });
  });
});

describe('contract with several alternates', () => {
  const base = (o: Partial<ContractInput> = {}): ContractInput => ({
    direction: 'dir', slideCount: 3, frameCount: 0, variables: ['hook', 'character', 'concept', 'scene'], mode: 'exploration', alternates: 7,
    locks: tagLocks([], universalLocks()), sourceDefaults: [], ...o,
  });
  const pool = (variable: string, n: number) => ({ variable, values: Array.from({ length: n }, (_, i) => ({ value: `${variable} ${i}`, slides: [] as never[] })) });
  const raw = (pools: unknown[]) => ({
    droppedSourceDefaults: [], droppedLocks: [], subject: 'objects', identity: 'none', identitySheet: 'a man', medium: 'pencil',
    keepSourceImage: false, borrowSourceLook: false, arcAxis: '', sourceFrameLevels: [],
    slides: [slide('Hook A', 'kitchen'), slide('two', 'kitchen'), slide('three', 'kitchen')], pools,
  });
  const angle = (n: number) => ({ variable: 'concept', values: Array.from({ length: n }, (_, i) => ({ value: `angle ${i}`, slides: [slide(`Angle ${i} one`, 'kitchen'), slide(`Angle ${i} two`, 'kitchen'), slide(`Angle ${i} three`, 'kitchen')] })) });
  const pools = () => [pool('hook', 4), pool('character', 3), angle(3), { variable: 'scene', values: [{ value: 'beach', slides: [] }, { value: 'train', slides: [] }] }];
  const e = (c: ReturnType<typeof normalizeContract>, variantCount: number) =>
    proposalsFromContract({ instructions: { direction: 'dir', goal: '', lockedConstraints: [] } as never, slideCount: 3, variantCount }, c);

  test('exploration builds baseline plus N alternates, each differing only in its declared axes', () => {
    const c = normalizeContract(raw(pools()) as never, base());
    expect(armsOf(c)).toHaveLength(7);
    const { proposals, notices } = e(c, 8);
    expect(proposals).toHaveLength(8);
    expect(notices).toEqual([]);
    expect(proposals[0]!.changedVariables).toEqual([]);
    expect(proposals.slice(1, 5).map(p => p.changedVariables.length)).toEqual([1, 1, 1, 1]);
    expect(proposals.slice(5).every(p => p.changedVariables.length >= 2)).toBe(true);
    expect(new Set(proposals.map(p => p.title)).size).toBe(8);
    expect(() => validateVariants({ pipeline: 'contract', variantCount: 8, slideCount: 3, instructions: { lockedConstraints: [], mode: 'exploration', variables: ['hook', 'character', 'concept', 'scene'] } } as never, proposals)).not.toThrow();
  });

  test('a hook-only alternate in a hook+scene run keeps the baseline scene', () => {
    const c = normalizeContract(raw([pool('hook', 1), pool('scene', 1)]) as never, base({ variables: ['hook', 'scene'], alternates: 3 }));
    const { proposals } = e(c, 4);
    const hookOnly = proposals.find(p => p.changedVariables.length === 1 && p.changedVariables[0]!.name === 'hook')!;
    expect(hookOnly.brief.slides?.map(s => s.scene) ?? []).not.toContain('beach');
  });

  test('variantCount 1 still plans one alternate and says so (SLA-841)', () => {
    const c = normalizeContract(raw([pool('hook', 1)]) as never, base({ variables: ['hook'], mode: 'controlled', alternates: 1 }));
    const { proposals, notices } = e(c, 1);
    expect(proposals).toHaveLength(2);
    expect(notices.join(' ')).toContain('instead of 1');
  });

  test('a pool that came back short is reported, not silently repeated', () => {
    const c = normalizeContract(raw([pool('hook', 2)]) as never, base({ variables: ['hook'], mode: 'controlled', alternates: 5 }));
    const { proposals, notices } = e(c, 6);
    expect(proposals.length).toBeLessThan(6);
    expect(notices.join(' ')).toContain('could be built instead of 6');
  });

  test('a stored legacy variantB still reads as one alternate', () => {
    const legacy = { variantB: { variable: 'hook' as ArmField, value: 'Hook B', slides: [] } };
    expect(armsOf(legacy)).toEqual([{ axes: [{ variable: 'hook', value: 'Hook B', slides: [] }] }]);
  });
});
