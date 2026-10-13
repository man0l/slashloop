// SLA-802: a brief-only experiment has no source video. The direction is the spec, the draft is still free,
// and the contract planner must work with zero source frames.
import { describe, expect, test } from 'bun:test';
import { CreateBrief, CreateBriefRequest, CreateRequest, DIRECTION_MAX, type Experiment } from './schema.js';
import { createExperiment, type CreateExperimentDeps } from './service.js';
import { contractPromptPayload, normalizeContract, tagLocks, type ContractInput } from './resolved-contract.js';
import { universalLocks } from './source-format.js';

const direction = 'Slide 1 overlay "Stop scrolling" on a kitchen counter. Slide 2 overlay "Try this" with a jar.';
const brief = (over: Record<string, unknown> = {}, instructions: Record<string, unknown> = {}) => ({
  workspaceId: 'w1', videoIds: [], variantCount: 2, slideCount: 6, maxCredits: 400, idempotencyKey: 'brief-key-12345',
  instructions: { goal: 'Test a hook', brand: '', audience: '', language: 'English', variables: ['hook'], direction, ...instructions },
  ...over,
});

function deps(persisted: Experiment[] = []): CreateExperimentDeps {
  return {
    findSource: async () => { throw new Error('a brief-only experiment must not look up sources'); },
    findLatestAnalysis: async () => { throw new Error('a brief-only experiment must not read analyses'); },
    buildInput: async () => { throw new Error('a brief-only experiment has no inputs'); },
    persist: async e => { persisted.push(e); return e; },
  };
}

describe('createExperiment({ sourceless })', () => {
  test('creates a free contract-pipeline draft with no inputs and the requested slide count', async () => {
    const out: Experiment[] = [];
    await createExperiment(brief(), deps(out), { sourceless: true });
    const e = out[0]!;
    expect(e.status).toBe('draft');
    expect(e.pipeline).toBe('contract');
    expect(e.inputs).toEqual([]);
    expect(e.tasks).toEqual([]);
    expect(e.variantCount).toBe(2);
    expect(e.slideCount).toBe(6);
    expect(e.creditsCharged).toBe(0);
    expect(e.generationBasis).toBe('text-directed');
    expect(e.instructions.direction).toBe(direction);
    expect(e.instructions.variables).toEqual(['hook']);
  });

  test('keeps the brief fields: locks, brand, audience, language and a long direction', async () => {
    const out: Experiment[] = [];
    const long = 'Slide copy. '.repeat(300).trim();
    await createExperiment(brief({}, { brand: 'Acme', audience: 'busy parents', language: 'German', lockedConstraints: ['No faces'], direction: long }), deps(out), { sourceless: true });
    const i = out[0]!.instructions;
    expect(i).toMatchObject({ brand: 'Acme', audience: 'busy parents', language: 'German', direction: long });
    expect(i.lockedConstraints).toContain('No faces');
  });

  test('variables default to the hook when omitted', async () => {
    const out: Experiment[] = [];
    await createExperiment(brief({}, { variables: undefined }), deps(out), { sourceless: true });
    expect(out[0]!.instructions.variables).toEqual(['hook']);
  });

  test('is idempotent on the request fingerprint', async () => {
    const seen: string[] = [];
    const d: CreateExperimentDeps = { ...deps(), persist: async (e, key) => { seen.push(`${key}:${e.createFingerprint}`); return e; } };
    await createExperiment(brief(), d, { sourceless: true });
    await createExperiment(brief(), d, { sourceless: true });
    expect(new Set(seen).size).toBe(1);
  });

  test('rejects videoIds, a missing direction and a blank direction', async () => {
    await expect(createExperiment(brief({ videoIds: ['v1'] }), deps(), { sourceless: true })).rejects.toThrow();
    await expect(createExperiment(brief({}, { direction: undefined }), deps(), { sourceless: true })).rejects.toThrow();
    await expect(createExperiment(brief({}, { direction: '   ' }), deps(), { sourceless: true })).rejects.toThrow();
  });

  test('without the sourceless option an empty videoIds list is still refused', async () => {
    await expect(createExperiment(brief(), deps())).rejects.toThrow();
  });
});

describe('brief schemas', () => {
  test('direction takes up to DIRECTION_MAX characters; other free-text fields keep their 2000 limit', () => {
    const over = 'x'.repeat(2500);
    expect(CreateBriefRequest.safeParse(brief({}, { direction: over })).success).toBe(true);
    expect(CreateRequest.safeParse({ ...brief({ videoIds: ['v1'] }), instructions: { ...brief().instructions, direction: over } }).success).toBe(true);
    expect(CreateBriefRequest.safeParse(brief({}, { direction: 'x'.repeat(DIRECTION_MAX + 1) })).success).toBe(false);
    expect(CreateBriefRequest.safeParse(brief({}, { brand: 'x'.repeat(2001) })).success).toBe(false);
  });

  test('CreateBriefRequest takes no videoIds; CreateBrief is strict', () => {
    expect(CreateBriefRequest.safeParse(brief({ videoIds: ['v1'] })).success).toBe(false);
    expect(CreateBriefRequest.safeParse(brief({ videoIds: undefined })).success).toBe(true);
    expect(CreateBrief.safeParse({ ...brief(), extra: 1 }).success).toBe(false);
  });

});

describe('contract planning with no source frames', () => {
  const input = (o: Partial<ContractInput> = {}): ContractInput => ({
    direction, slideCount: 3, frameCount: 0, variable: 'hook', locks: tagLocks(universalLocks(), universalLocks()), sourceDefaults: [], ...o,
  });
  const slide = (overlayText: string) => ({ overlayText, arcLevel: 'none', scene: 'a scene', composition: 'centred', visibleChange: '' });
  const raw = (o: Record<string, unknown> = {}) => ({
    droppedSourceDefaults: [], droppedLocks: [], subject: 'objects', identity: 'none', identitySheet: '', medium: 'photograph',
    keepSourceImage: false, borrowSourceLook: false, arcAxis: '', sourceFrameLevels: [],
    slides: [slide('Hook A'), slide('two'), slide('three')], variantB: { variable: 'hook', value: 'Hook B', slides: [] }, ...o,
  });

  test('a clean contract normalizes with zero source frames', () => {
    const c = normalizeContract(raw(), input());
    expect(c.slides).toHaveLength(3);
    expect(c.sourceFrames).toEqual([]);
    expect(c.keepSourceImage).toBe(false);
  });

  test('keepSourceImage and borrowSourceLook are voided, with an issue noting it', () => {
    const c = normalizeContract(raw({ keepSourceImage: true, borrowSourceLook: true, identity: 'source' }), input());
    expect(c.keepSourceImage).toBe(false);
    expect(c.borrowSourceLook).toBe(false);
    expect(c.identity).toBe('invented-per-slide');
    expect(JSON.stringify(c)).toContain('no source video');
  });

  test('the model prompt says there is no source only when there are no frames', () => {
    expect(JSON.parse(contractPromptPayload(input())).sourceNote).toContain('no source video');
    expect(JSON.parse(contractPromptPayload(input({ frameCount: 3 }))).sourceNote).toBeUndefined();
  });
});
